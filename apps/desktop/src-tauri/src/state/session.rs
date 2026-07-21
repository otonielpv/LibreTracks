//! Session/project lifecycle on `DesktopSession`: creating songs (blank or from
//! a template), saving (in place, as, and as a template), opening projects from
//! disk or dialog, resolving missing audio files, and the whole-session `.ltset`
//! package export/import.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use libretracks_core::Song;
use libretracks_project::{
    extract_session_package, load_song_from_file, save_song_to_file, ExtractedSessionPackage,
    ExtractedSongPackage, SidecarFile,
};

use tauri::AppHandle;

use crate::audio::engine::AudioController;
use crate::audio::automation::{save_automation, AutomationDocument, AUTOMATION_FILE_NAME};
use crate::error::DesktopError;
use crate::platform::file_dialog::FileDialog;
use crate::models::TransportSnapshot;

use super::{
    build_empty_song, build_template_song, copy_project_audio_files, default_project_file_name,
    emit_project_load_progress, library_manifest_path, list_library_assets, project_root,
    read_library_manifest, strip_song_to_template, timestamp_suffix, write_library_manifest,
    write_library_manifest_assets, AudioChangeImpact, DesktopSession, LIBRARY_MANIFEST_FILE_NAME,
};

impl DesktopSession {
    pub fn ensure_song_loaded_for_external_import(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if self.engine.song().is_some() {
            return Ok(());
        }

        let base_dir = project_root(app).join("imports");
        fs::create_dir_all(&base_dir)?;

        let mut attempt = 0_u32;
        let (song_dir, song_file_path) = loop {
            let suffix = timestamp_suffix();
            let folder_name = if attempt == 0 {
                format!("import-session-{suffix}")
            } else {
                format!("import-session-{suffix}-{attempt}")
            };
            let candidate_dir = base_dir.join(&folder_name);
            if !candidate_dir.exists() {
                break (
                    candidate_dir.clone(),
                    candidate_dir.join("import-session.ltsession"),
                );
            }
            attempt = attempt.saturating_add(1);
        };

        fs::create_dir_all(song_dir.join("audio"))?;
        fs::create_dir_all(song_dir.join("cache").join("waveforms"))?;
        write_library_manifest(&song_dir, &[])?;

        let song = build_empty_song(
            format!("song_import_{}", timestamp_suffix()),
            "Import Reaper/Ableton".to_string(),
        );
        save_song_to_file(&song_file_path, &song)?;
        self.load_song_from_path(song, song_dir, audio)?;
        self.song_file_path = Some(song_file_path);

        eprintln!("[libretracks-import] bootstrap empty session created for wizard import");

        Ok(())
    }

    pub fn create_song(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<Option<TransportSnapshot>, DesktopError> {
        let default_directory = project_root(app).join("songs");
        // The user picks the .ltsession name + parent location with the native
        // save dialog. We then create a project folder named after the file
        // stem and place the .ltsession (plus audio/, cache/) inside it —
        // Ableton-style. This means a user can pick "MyShow.ltsession" in
        // any folder without first having to create a MyShow/ subfolder.
        let target_pick = FileDialog::new()
            .set_title("Crear proyecto")
            .set_directory(&default_directory)
            .add_filter("LibreTracks Session", &["ltsession"])
            .set_file_name(&default_project_file_name("Nueva Cancion"))
            .save_file();

        let Some(target_pick) = target_pick else {
            return Ok(None);
        };

        self.create_song_at_path(target_pick, audio).map(Some)
    }

    /// Heavy half of `create_song`: writes the project folder + .ltsession and
    /// loads it into the engine. Split out from the native dialog so the
    /// command layer can run this on a worker thread — running it on the main
    /// thread (as a sync Tauri command does) freezes the macOS run loop and
    /// hangs the window on the "Applying changes" overlay.
    pub fn create_song_at_path(
        &mut self,
        target_pick: PathBuf,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let title = "Nueva Cancion".to_string();
        let song_id = format!("song_{}", timestamp_suffix());
        let song = build_empty_song(song_id, title);
        self.create_song_at_path_with(target_pick, song, audio)
    }

    /// Create a brand-new project at `target_pick` whose arrangement structure
    /// comes from a `.lttemplate` file (tracks, folder hierarchy and routing).
    /// The template is loaded, stripped of any residual clips/regions and given
    /// fresh entity ids/title so the resulting session is a clean slate ready to
    /// receive audio (see [`build_template_song`]).
    pub fn create_song_from_template_path(
        &mut self,
        template_path: PathBuf,
        target_pick: PathBuf,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let template_song = load_song_from_file(&template_path).map_err(|error| {
            DesktopError::AudioCommand(format!(
                "no se pudo leer la plantilla \"{}\": {error}",
                template_path.display()
            ))
        })?;

        let project_name = target_pick
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Nueva Cancion".to_string());
        let song_id = format!("song_{}", timestamp_suffix());
        let song = build_template_song(template_song, song_id, project_name);

        self.create_song_at_path_with(target_pick, song, audio)
    }

    /// Shared body for creating a new on-disk project (empty or from a
    /// template): builds the Ableton-style folder layout, writes the session
    /// document and loads it into the engine. `song` is whatever arrangement the
    /// caller wants the fresh project to start with.
    fn create_song_at_path_with(
        &mut self,
        target_pick: PathBuf,
        song: Song,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let parent_dir = target_pick.parent().map(Path::to_path_buf).ok_or_else(|| {
            DesktopError::AudioCommand("no se pudo determinar la carpeta destino".into())
        })?;
        let project_name = target_pick
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                DesktopError::AudioCommand("el nombre del proyecto no es valido".into())
            })?;

        let song_dir = parent_dir.join(&project_name);
        if song_dir.exists() {
            return Err(DesktopError::AudioCommand(format!(
                "ya existe una carpeta llamada \"{}\" en esa ubicacion. Elige otro nombre.",
                project_name
            )));
        }
        let target_song_file = song_dir.join(format!("{}.ltsession", project_name));

        fs::create_dir_all(song_dir.join("audio"))?;
        fs::create_dir_all(song_dir.join("cache").join("waveforms"))?;
        write_library_manifest(&song_dir, &[])?;
        save_automation(&song_dir, &AutomationDocument::default())
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;

        let save_started_at = Instant::now();
        save_song_to_file(&target_song_file, &song)?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();
        self.load_song_from_path(song, song_dir, audio)?;
        self.song_file_path = Some(target_song_file);

        Ok(self.snapshot())
    }

    /// Serialize the currently loaded session as a portable `.lttemplate` file
    /// at `template_path`. Only the organizational structure is kept (tracks,
    /// folder hierarchy, routing, names and colors); clips, regions, markers and
    /// per-track mix are dropped so the template is a clean starting point.
    pub fn save_current_as_template(&self, template_path: PathBuf) -> Result<(), DesktopError> {
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let template = strip_song_to_template(song);
        save_song_to_file(&template_path, &template)?;
        Ok(())
    }

    pub fn save_project(&mut self) -> Result<TransportSnapshot, DesktopError> {
        let song_file_path = self.current_song_file_path()?;
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let save_started_at = Instant::now();
        save_song_to_file(&song_file_path, &song)?;
        save_automation(&song_dir, &self.automation)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();
        Ok(self.snapshot())
    }

    pub fn resolve_missing_file(
        &mut self,
        old_path: &str,
        new_path: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song_file_path = self.current_song_file_path()?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        for clip in song.clips.iter_mut() {
            if clip.file_path == old_path {
                clip.file_path = new_path.to_string();
            }
        }

        if let Some(mut manifest) = read_library_manifest(&song_dir)? {
            for file_path in manifest.file_paths.iter_mut() {
                if file_path == old_path {
                    *file_path = new_path.to_string();
                }
            }
            for asset in manifest.assets.iter_mut() {
                if asset.file_path == old_path {
                    asset.file_path = new_path.to_string();
                }
            }
            let manifest_json = serde_json::to_vec_pretty(&manifest)
                .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
            fs::write(library_manifest_path(&song_dir), manifest_json)?;
        }

        // Waveforms now live in the global per-file cache keyed by the audio's
        // path+size+mtime. Renaming the audio simply maps to a different cache
        // entry: the new path migrates/regenerates on next load and the old
        // entry is reclaimed by the cache's purge — there is nothing per-project
        // to move here. We only drop the stale in-memory entry.
        self.waveform_cache.remove(&song_dir, old_path);
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        let save_started_at = Instant::now();
        let saved_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        save_song_to_file(&song_file_path, &saved_song)?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();

        Ok(self.snapshot())
    }

    pub fn save_project_as(&mut self) -> Result<Option<TransportSnapshot>, DesktopError> {
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let target_pick = FileDialog::new()
            .add_filter("LibreTracks Session", &["ltsession"])
            .set_title("Guardar proyecto como")
            .set_file_name(&default_project_file_name(&song.title))
            .save_file();

        let Some(target_pick) = target_pick else {
            return Ok(None);
        };

        self.save_project_as_to_path(target_pick).map(Some)
    }

    /// Heavy half of `save_project_as`: copies the project's audio and writes
    /// the new .ltsession. Split out from the native dialog so the command
    /// layer can run it on a worker thread instead of freezing the macOS main
    /// run loop. See [`create_song_at_path`](Self::create_song_at_path).
    pub fn save_project_as_to_path(
        &mut self,
        target_pick: PathBuf,
    ) -> Result<TransportSnapshot, DesktopError> {
        let source_song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Save As mirrors Create: the user picks <name>.ltsession in any
        // folder, and we create a <name>/ subfolder containing the session
        // file plus audio/ and cache/.
        let parent_dir = target_pick.parent().map(Path::to_path_buf).ok_or_else(|| {
            DesktopError::AudioCommand("no se pudo determinar la carpeta destino".into())
        })?;
        let project_name = target_pick
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                DesktopError::AudioCommand("el nombre del proyecto no es valido".into())
            })?;

        let target_song_dir = parent_dir.join(&project_name);
        if target_song_dir.exists() && target_song_dir != source_song_dir {
            return Err(DesktopError::AudioCommand(format!(
                "ya existe una carpeta llamada \"{}\" en esa ubicacion. Elige otro nombre.",
                project_name
            )));
        }
        let target_song_file = target_song_dir.join(format!("{}.ltsession", project_name));

        let save_started_at = Instant::now();
        let library_assets = list_library_assets(&source_song_dir, Some(&song))?;
        let library_file_paths = library_assets
            .iter()
            .map(|asset| asset.file_path.clone())
            .collect::<Vec<_>>();
        copy_project_audio_files(
            &source_song_dir,
            &target_song_dir,
            &song,
            &library_file_paths,
        )?;
        write_library_manifest_assets(&target_song_dir, &library_assets)?;
        save_song_to_file(&target_song_file, &song)?;
        save_automation(&target_song_dir, &self.automation)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();

        self.song_dir = Some(target_song_dir.clone());
        self.song_file_path = Some(target_song_file);
        self.prime_waveform_cache(&target_song_dir, &song)?;

        Ok(self.snapshot())
    }

    /// Resolve the source data for a whole-session `.ltset` export: the live
    /// song dir, the in-memory song (so unsaved edits are captured), and the
    /// sidecar files that must travel with it. Automation is flushed to disk
    /// first so its sidecar reflects the current state, mirroring `save_project`.
    pub fn prepare_session_package_export(
        &self,
    ) -> Result<(PathBuf, Song, Vec<SidecarFile>), DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Flush automation so the bundled sidecar matches the live session.
        save_automation(&song_dir, &self.automation)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;

        let sidecars = vec![
            SidecarFile {
                file_name: LIBRARY_MANIFEST_FILE_NAME.to_string(),
            },
            SidecarFile {
                file_name: AUTOMATION_FILE_NAME.to_string(),
            },
        ];

        Ok((song_dir, song, sidecars))
    }

    /// Inflate a `.ltset` into a freshly created project folder and open it as a
    /// new session, replacing whatever was loaded. This is the "create at home,
    /// open at the venue" flow — it does NOT merge into the current session.
    ///
    /// `target_song_dir` must not already exist (the caller picks a name/location
    /// and we own the folder). The slow decompression runs on the calling
    /// thread; callers run this off the session lock.
    pub fn import_session_package_as_new(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        package_path: &Path,
        target_song_dir: &Path,
    ) -> Result<TransportSnapshot, DesktopError> {
        if target_song_dir.exists() {
            return Err(DesktopError::AudioCommand(format!(
                "ya existe una carpeta llamada \"{}\" en esa ubicacion. Elige otro nombre.",
                target_song_dir
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("proyecto")
            )));
        }

        emit_project_load_progress(app, 8, "Descomprimiendo sesion...".into(), 0, 0, 0, 0);
        let extracted: ExtractedSessionPackage =
            extract_session_package(target_song_dir, package_path, |done, total| {
                if total > 0 {
                    // Decompression occupies the 8–40% band; audio prep takes over after.
                    let percent = (8 + ((done as f64 / total as f64) * 32.0) as u32).min(40) as u8;
                    emit_project_load_progress(
                        app,
                        percent,
                        "Descomprimiendo sesion...".into(),
                        0,
                        0,
                        0,
                        0,
                    );
                }
            })
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;

        self.begin_open_project_from_path(app, audio, extracted.song_file)?;
        Ok(self.snapshot())
    }

    pub fn open_project_from_dialog(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<Option<TransportSnapshot>, DesktopError> {
        let song_file = FileDialog::new()
            .add_filter("LibreTracks Session", &["ltsession"])
            .set_title("Selecciona session.ltsession")
            .pick_file();

        let Some(song_file) = song_file else {
            return Ok(None);
        };

        self.open_project_from_path(app, audio, song_file).map(Some)
    }

    pub fn open_project_from_path(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        song_file: PathBuf,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.begin_open_project_from_path(app, audio, song_file)?;
        self.wait_for_project_audio_preparation(app, audio)?;

        Ok(self.snapshot())
    }

    pub fn begin_open_project_from_path(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        song_file: PathBuf,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = song_file
            .parent()
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| {
                DesktopError::AudioCommand("session.ltsession must live inside a folder".into())
            })?;
        emit_project_load_progress(app, 5, "Leyendo archivo de proyecto...".into(), 0, 0, 0, 0);
        let song = load_song_from_file(&song_file)?;

        emit_project_load_progress(app, 10, "Proyecto leido.".into(), 0, 0, 0, 0);
        emit_project_load_progress(app, 14, "Cargando sesion de audio...".into(), 0, 0, 0, 0);
        self.load_song_from_path(song, song_dir, audio)?;
        emit_project_load_progress(
            app,
            18,
            "Registrando fuentes de audio...".into(),
            0,
            0,
            0,
            0,
        );
        self.song_file_path = Some(song_file);

        Ok(self.snapshot())
    }

    /// Heavy half of the package-import flow: unpacks the .ltpkg and decodes
    /// its sources. Split out from the native dialog so the command layer can
    /// run it on a worker thread instead of freezing the macOS main run loop.
    /// See [`create_song_at_path`](Self::create_song_at_path).
    /// Read the destination dir for a package import. The caller uses this to
    /// run the slow decompression (`extract_song_package`) WITHOUT holding the
    /// session lock — see `start_import_song_package_from_path`.
    pub fn package_import_song_dir(&self) -> Result<PathBuf, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        // Confirm a song is loaded now so the caller fails fast before doing the
        // expensive extraction; we re-clone the (possibly newer) song under the
        // lock when applying.
        self.engine.song().ok_or(DesktopError::NoSongLoaded)?;
        Ok(song_dir)
    }

    /// Merge an already-decompressed package (`extract_song_package`) into the
    /// current song. This is the fast, session-bound half of an import; the
    /// caller holds the session lock only for this call, never for the
    /// decompression that precedes it.
    pub fn import_song_from_extracted(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        extracted: ExtractedSongPackage,
        insert_at_seconds: f64,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.song_dir.as_ref().ok_or(DesktopError::NoSongLoaded)?;
        self.engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Merge WITHOUT blocking on source decode. This phase repoints copied
        // audio, persists the structure (StructureRebuild → the engine's
        // incremental upsert), and primes the waveform cache — all fast — giving
        // the frontend a complete song (tracks + clips + waveform placeholders).
        // The sources are enqueued for background decode by the upsert; we do
        // NOT wait for them here. Play is progressive (decoded head audible, rest
        // silent — R5). Previously this also unzipped under the session lock,
        // which froze the UI for the whole import of a large package.
        let inserted =
            self.import_song_package_no_wait(app, extracted, insert_at_seconds, audio)?;

        Ok(inserted.snapshot)
    }
}
