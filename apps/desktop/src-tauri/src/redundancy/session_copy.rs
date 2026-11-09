//! Copy the main's session to the backup over the redundancy channel
//! (redundancy step 18).
//!
//! - The main answers a `SessionRequest` with a manifest: its in-memory song
//!   serialized (audio paths rewritten relative to the folder: an absolute
//!   path on the main means nothing on the backup) and every file of the
//!   folder with its size. Waveform caches stay out (regenerated).
//! - The backup plans: files it already has at the same path and size are
//!   kept; files with the same name and size anywhere in its current session
//!   are copied locally; only the rest travels, pulled in 1 MiB chunks.
//! - Each file lands as `<path>.part` and is renamed when complete; the song
//!   document is written LAST, so an interrupted copy never leaves a session
//!   that opens half-copied.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use libretracks_core::session_fingerprint::file_key;
use libretracks_core::Song;
use libretracks_link::redundancy::{RedundancyMessage, SessionFile};
use serde::Serialize;

pub const CHUNK_BYTES: u64 = 1 << 20;
/// Folder names of a session that are never copied (regenerated caches).
const SKIPPED_DIRS: &[&str] = &["cache"];

// --- main side ---

/// What the main serves for one request.
#[derive(Debug, Clone)]
pub struct ServedSession {
    pub name: String,
    pub song_document: String,
    pub files: Vec<SessionFile>,
    /// Manifest path → where the bytes are on the main.
    pub sources: HashMap<String, PathBuf>,
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.ends_with(".part") {
            continue;
        }
        if path.is_dir() {
            if dir == base && SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(&path, base, out);
        } else if let Ok(relative) = path.strip_prefix(base) {
            let relative = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            out.push((relative, path));
        }
    }
}

/// Every clip path of the song, the stored arrangement copies included.
fn clip_paths_mut(song: &mut Song) -> Vec<&mut String> {
    let mut paths: Vec<&mut String> = song.clips.iter_mut().map(|clip| &mut clip.file_path).collect();
    for region in &mut song.regions {
        if let Some(structure) = &mut region.structure {
            paths.extend(structure.stored_clips_mut().map(|clip| &mut clip.file_path));
        }
    }
    paths
}

/// The main's manifest. `song_file_name` is skipped from the folder walk:
/// the in-memory song travels instead (it may have unsaved edits, and it is
/// what the fingerprint compared).
pub fn build_manifest(name: &str, song: &Song, song_dir: &Path, song_file_name: &str) -> Result<ServedSession, String> {
    let mut walked = Vec::new();
    walk(song_dir, song_dir, &mut walked);
    let mut sources: HashMap<String, PathBuf> = walked
        .into_iter()
        .filter(|(relative, _)| relative != song_file_name)
        .collect();

    let mut song = song.clone();
    for path in clip_paths_mut(&mut song) {
        let as_path = PathBuf::from(path.as_str());
        if !as_path.is_absolute() {
            continue;
        }
        let relative = match as_path.strip_prefix(song_dir) {
            Ok(inside) => inside.to_string_lossy().replace('\\', "/"),
            Err(_) => {
                // Outside the folder (imported by reference): it travels to
                // `audio/<name>`, keeping the name's case.
                let Some(name) = as_path.file_name() else {
                    continue;
                };
                let relative = format!("audio/{}", name.to_string_lossy());
                sources.entry(relative.clone()).or_insert(as_path.clone());
                relative
            }
        };
        *path = relative;
    }

    let song_document =
        libretracks_project::serialize_song_document(&song).map_err(|error| error.to_string())?;
    let mut files: Vec<SessionFile> = sources
        .iter()
        .filter_map(|(path, source)| {
            fs::metadata(source).ok().map(|meta| SessionFile {
                path: path.clone(),
                size: meta.len(),
            })
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ServedSession {
        name: name.to_string(),
        song_document,
        files,
        sources,
    })
}

/// One chunk of one manifest file. Only manifest paths are served (no path
/// from the backup ever reaches the file system directly).
pub fn read_chunk(served: &ServedSession, path: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    let source = served.sources.get(path).ok_or("not in the manifest")?;
    let mut file = File::open(source).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
    let mut buffer = Vec::with_capacity(length.min(CHUNK_BYTES) as usize);
    file.take(length.min(CHUNK_BYTES))
        .read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;
    Ok(buffer)
}

pub fn chunk_message(served: &ServedSession, request_id: u64, path: &str, offset: u64, length: u64) -> RedundancyMessage {
    match read_chunk(served, path, offset, length) {
        Ok(bytes) => RedundancyMessage::FileChunk {
            request_id,
            path: path.to_string(),
            offset,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            error: None,
        },
        Err(error) => RedundancyMessage::FileChunk {
            request_id,
            path: path.to_string(),
            offset,
            data: String::new(),
            error: Some(error),
        },
    }
}

// --- backup side ---

/// Files of the backup's current session, by (case-folded name, size), to
/// copy locally instead of over the network.
pub fn local_candidates(song_dir: Option<&Path>, song: Option<&Song>) -> HashMap<(String, u64), PathBuf> {
    let mut found = HashMap::new();
    let mut add = |path: PathBuf| {
        if let Ok(meta) = fs::metadata(&path) {
            if meta.is_file() {
                found
                    .entry((file_key(&path.to_string_lossy()), meta.len()))
                    .or_insert(path);
            }
        }
    };
    if let Some(dir) = song_dir {
        let mut walked = Vec::new();
        walk(dir, dir, &mut walked);
        for (_, path) in walked {
            add(path);
        }
    }
    if let (Some(song), Some(dir)) = (song, song_dir) {
        for clip in &song.clips {
            let path = PathBuf::from(&clip.file_path);
            add(if path.is_absolute() { path } else { dir.join(path) });
        }
    }
    found
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CopyPlan {
    /// Already at the target with the same size.
    pub keep: Vec<SessionFile>,
    /// Copied from another local file with the same name and size.
    pub reuse: Vec<(SessionFile, PathBuf)>,
    /// Pulled from the main.
    pub fetch: Vec<SessionFile>,
}

impl CopyPlan {
    pub fn fetch_bytes(&self) -> u64 {
        self.fetch.iter().map(|file| file.size).sum()
    }
}

/// Pure but for reading sizes at `target`.
pub fn plan_copy(
    files: &[SessionFile],
    target: &Path,
    candidates: &HashMap<(String, u64), PathBuf>,
) -> CopyPlan {
    let mut plan = CopyPlan::default();
    for file in files {
        let existing = fs::metadata(target.join(&file.path)).ok().map(|meta| meta.len());
        if existing == Some(file.size) {
            plan.keep.push(file.clone());
        } else if let Some(local) = candidates.get(&(file_key(&file.path), file.size)) {
            plan.reuse.push((file.clone(), local.clone()));
        } else {
            plan.fetch.push(file.clone());
        }
    }
    plan
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyProgress {
    pub done_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, PartialEq)]
pub enum CopyStep {
    /// Ask the main for this.
    Request(RedundancyMessage),
    /// Everything is in place: open this song file.
    Done(PathBuf),
    Failed(String),
}

/// One copy in progress on the backup.
#[derive(Debug)]
pub struct CopyJob {
    pub request_id: u64,
    target: PathBuf,
    song_document: String,
    queue: VecDeque<SessionFile>,
    current: Option<(SessionFile, File, u64)>,
    pub progress: CopyProgress,
}

fn part_path(target: &Path, path: &str) -> PathBuf {
    target.join(format!("{path}.part"))
}

fn finish_file(target: &Path, path: &str) -> Result<(), String> {
    let final_path = target.join(path);
    if final_path.exists() {
        fs::remove_file(&final_path).map_err(|error| error.to_string())?;
    }
    fs::rename(part_path(target, path), final_path).map_err(|error| error.to_string())
}

/// Where a copied session lives on the backup.
pub fn target_dir(root: &Path, name: &str) -> PathBuf {
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    root.join(if safe.trim().is_empty() { "session".into() } else { safe.trim().to_string() })
}

impl CopyJob {
    /// Lay out the plan (local copies done right here) and return the first
    /// step.
    pub fn start(
        request_id: u64,
        manifest_files: &[SessionFile],
        song_document: String,
        target: PathBuf,
        candidates: &HashMap<(String, u64), PathBuf>,
    ) -> Result<(CopyJob, CopyStep), String> {
        fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        let plan = plan_copy(manifest_files, &target, candidates);
        for (file, local) in &plan.reuse {
            let part = part_path(&target, &file.path);
            if let Some(parent) = part.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(local, &part).map_err(|error| error.to_string())?;
            finish_file(&target, &file.path)?;
        }
        let mut job = CopyJob {
            request_id,
            target,
            song_document,
            progress: CopyProgress {
                done_bytes: 0,
                total_bytes: plan.fetch_bytes(),
            },
            queue: plan.fetch.into_iter().collect(),
            current: None,
        };
        let step = job.next();
        Ok((job, step))
    }

    fn next(&mut self) -> CopyStep {
        loop {
            if let Some((file, _, offset)) = &self.current {
                if *offset >= file.size {
                    let path = file.path.clone();
                    self.current = None;
                    if let Err(error) = finish_file(&self.target, &path) {
                        return CopyStep::Failed(error);
                    }
                    continue;
                }
                return CopyStep::Request(RedundancyMessage::FileChunkRequest {
                    request_id: self.request_id,
                    path: file.path.clone(),
                    offset: *offset,
                    length: CHUNK_BYTES.min(file.size - offset),
                });
            }
            let Some(file) = self.queue.pop_front() else {
                // Last: the document that makes it a session.
                let song_file = self.target.join(libretracks_project::SONG_FILE_NAME);
                return match fs::write(&song_file, &self.song_document) {
                    Ok(()) => CopyStep::Done(song_file),
                    Err(error) => CopyStep::Failed(error.to_string()),
                };
            };
            let part = part_path(&self.target, &file.path);
            if let Some(parent) = part.parent() {
                if let Err(error) = fs::create_dir_all(parent) {
                    return CopyStep::Failed(error.to_string());
                }
            }
            match OpenOptions::new().create(true).write(true).truncate(true).open(&part) {
                Ok(handle) => self.current = Some((file, handle, 0)),
                Err(error) => return CopyStep::Failed(error.to_string()),
            }
        }
    }

    /// A chunk arrived.
    pub fn on_chunk(&mut self, path: &str, offset: u64, data: &str, error: Option<&str>) -> CopyStep {
        if let Some(error) = error {
            return CopyStep::Failed(format!("{path}: {error}"));
        }
        let Some((file, handle, expected)) = &mut self.current else {
            return CopyStep::Failed("unexpected chunk".into());
        };
        if file.path != path || *expected != offset {
            return CopyStep::Failed(format!("out-of-order chunk for {path}"));
        }
        let bytes = match base64::engine::general_purpose::STANDARD.decode(data) {
            Ok(bytes) => bytes,
            Err(error) => return CopyStep::Failed(error.to_string()),
        };
        if bytes.is_empty() {
            return CopyStep::Failed(format!("{path}: empty chunk"));
        }
        if let Err(error) = handle.write_all(&bytes) {
            return CopyStep::Failed(error.to_string());
        }
        *expected += bytes.len() as u64;
        self.progress.done_bytes += bytes.len() as u64;
        self.next()
    }
}

#[cfg(test)]
#[path = "session_copy_tests.rs"]
mod tests;
