use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalProjectKind {
    Reaper,
    Ableton,
}

#[derive(Debug, Clone)]
pub struct ReaperProject {
    pub title: String,
    pub bpm: Option<f64>,
    pub time_signature: Option<String>,
    pub duration_seconds: f64,
    pub tracks: Vec<ReaperTrack>,
}

#[derive(Debug, Clone)]
pub struct ReaperTrack {
    pub name: String,
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
    pub items: Vec<ReaperItem>,
}

#[derive(Debug, Clone)]
pub struct ReaperItem {
    pub position_seconds: f64,
    pub length_seconds: f64,
    pub source_start_seconds: f64,
    pub source_path: PathBuf,
    pub gain: f64,
    pub muted: bool,
}

#[derive(Debug, Clone)]
struct ReaperTrackBuilder {
    name: Option<String>,
    volume: f64,
    pan: f64,
    muted: bool,
    solo: bool,
    items: Vec<ReaperItem>,
}

impl Default for ReaperTrackBuilder {
    fn default() -> Self {
        Self {
            name: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct ReaperItemBuilder {
    position_seconds: f64,
    length_seconds: f64,
    source_start_seconds: f64,
    source_path: Option<PathBuf>,
    gain: f64,
    muted: bool,
}

impl Default for ReaperItemBuilder {
    fn default() -> Self {
        Self {
            position_seconds: 0.0,
            length_seconds: 0.0,
            source_start_seconds: 0.0,
            source_path: None,
            gain: 1.0,
            muted: false,
        }
    }
}

pub fn detect_external_project_kind(path: &Path) -> Option<ExternalProjectKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "rpp" => Some(ExternalProjectKind::Reaper),
        "als" => Some(ExternalProjectKind::Ableton),
        _ => None,
    }
}

pub fn parse_reaper_project(path: &Path) -> Result<ReaperProject, String> {
    let root = path
        .parent()
        .ok_or_else(|| "no se pudo resolver la carpeta del proyecto Reaper".to_string())?;
    let content = fs::read_to_string(path)
        .map_err(|error| format!("no se pudo leer el proyecto Reaper: {error}"))?;

    let mut bpm = None;
    let mut time_signature = None;
    let mut tracks = Vec::new();

    let mut current_track: Option<ReaperTrackBuilder> = None;
    let mut current_item: Option<ReaperItemBuilder> = None;
    let mut source_depth = 0_u32;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if line.starts_with("<TRACK") {
            if let Some(track) = current_track.take() {
                tracks.push(build_track(track, tracks.len()));
            }
            current_track = Some(ReaperTrackBuilder::default());
            current_item = None;
            source_depth = 0;
            continue;
        }

        if line.starts_with("<ITEM") {
            current_item = Some(ReaperItemBuilder::default());
            source_depth = 0;
            continue;
        }

        if line.starts_with("<SOURCE") {
            source_depth = source_depth.saturating_add(1);
            continue;
        }

        if line == ">" {
            if source_depth > 0 {
                source_depth -= 1;
                continue;
            }

            if let Some(item_builder) = current_item.take() {
                if let (Some(track), Some(item)) = (current_track.as_mut(), build_item(item_builder)) {
                    track.items.push(item);
                }
                continue;
            }

            if let Some(track) = current_track.take() {
                tracks.push(build_track(track, tracks.len()));
                continue;
            }

            continue;
        }

        if let Some(track) = current_track.as_mut() {
            if let Some(item) = current_item.as_mut() {
                if source_depth > 0 {
                    if line.starts_with("FILE ") {
                        if let Some(file_value) = parse_quoted_or_tail(line, "FILE") {
                            item.source_path = Some(resolve_source_path(root, &file_value));
                        }
                    }
                    continue;
                }

                if let Some(value) = parse_numeric_tail(line, "POSITION") {
                    item.position_seconds = value.max(0.0);
                    continue;
                }
                if let Some(value) = parse_numeric_tail(line, "LENGTH") {
                    item.length_seconds = value.max(0.0);
                    continue;
                }
                if let Some(value) = parse_numeric_tail(line, "SOFFS") {
                    item.source_start_seconds = value.max(0.0);
                    continue;
                }
                if line.starts_with("VOLPAN ") {
                    let parts = tokenize_space_separated(line);
                    if let Some(value) = parts.get(1).and_then(|value| value.parse::<f64>().ok()) {
                        item.gain = value.max(0.0);
                    }
                    continue;
                }
                if line.starts_with("MUTE ") {
                    let parts = tokenize_space_separated(line);
                    item.muted = parts
                        .get(1)
                        .and_then(|value| value.parse::<i32>().ok())
                        .map(|value| value != 0)
                        .unwrap_or(false);
                    continue;
                }
            }

            if line.starts_with("NAME ") {
                track.name = parse_quoted_or_tail(line, "NAME");
                continue;
            }
            if line.starts_with("VOLPAN ") {
                let parts = tokenize_space_separated(line);
                if let Some(value) = parts.get(1).and_then(|value| value.parse::<f64>().ok()) {
                    track.volume = value.max(0.0);
                }
                if let Some(value) = parts.get(2).and_then(|value| value.parse::<f64>().ok()) {
                    track.pan = value.clamp(-1.0, 1.0);
                }
                continue;
            }
            if line.starts_with("MUTESOLO ") {
                let parts = tokenize_space_separated(line);
                track.muted = parts
                    .get(1)
                    .and_then(|value| value.parse::<i32>().ok())
                    .map(|value| value != 0)
                    .unwrap_or(false);
                track.solo = parts
                    .get(2)
                    .and_then(|value| value.parse::<i32>().ok())
                    .map(|value| value != 0)
                    .unwrap_or(false);
                continue;
            }
        } else {
            if line.starts_with("TEMPO ") {
                let parts = tokenize_space_separated(line);
                if let Some(value) = parts.get(1).and_then(|value| value.parse::<f64>().ok()) {
                    bpm = Some(value.max(20.0));
                }
                if let (Some(n), Some(d)) = (
                    parts.get(2).and_then(|value| value.parse::<u32>().ok()),
                    parts.get(3).and_then(|value| value.parse::<u32>().ok()),
                ) {
                    time_signature = Some(format!("{n}/{d}"));
                }
                continue;
            }
        }
    }

    if let Some(item_builder) = current_item.take() {
        if let (Some(track), Some(item)) = (current_track.as_mut(), build_item(item_builder)) {
            track.items.push(item);
        }
    }
    if let Some(track) = current_track.take() {
        tracks.push(build_track(track, tracks.len()));
    }

    if tracks.is_empty() {
        return Err("el proyecto Reaper no contiene pistas importables".to_string());
    }

    let duration_seconds = tracks
        .iter()
        .flat_map(|track| track.items.iter())
        .map(|item| item.position_seconds + item.length_seconds)
        .fold(0.0_f64, f64::max)
        .max(1.0);

    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Reaper Import")
        .to_string();

    Ok(ReaperProject {
        title,
        bpm,
        time_signature,
        duration_seconds,
        tracks,
    })
}

fn build_track(builder: ReaperTrackBuilder, index: usize) -> ReaperTrack {
    ReaperTrack {
        name: builder
            .name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("Track {}", index + 1)),
        volume: builder.volume.max(0.0),
        pan: builder.pan.clamp(-1.0, 1.0),
        muted: builder.muted,
        solo: builder.solo,
        items: builder.items,
    }
}

fn build_item(builder: ReaperItemBuilder) -> Option<ReaperItem> {
    let source_path = builder.source_path?;
    if builder.length_seconds <= 0.0 {
        return None;
    }

    Some(ReaperItem {
        position_seconds: builder.position_seconds.max(0.0),
        length_seconds: builder.length_seconds.max(0.0),
        source_start_seconds: builder.source_start_seconds.max(0.0),
        source_path,
        gain: builder.gain.max(0.0),
        muted: builder.muted,
    })
}

fn parse_quoted_or_tail(line: &str, prefix: &str) -> Option<String> {
    let tail = line.strip_prefix(prefix)?.trim();
    if tail.is_empty() {
        return None;
    }

    if let Some(stripped) = tail.strip_prefix('"') {
        let mut end = None;
        for (index, character) in stripped.char_indices() {
            if character == '"' {
                end = Some(index);
                break;
            }
        }
        if let Some(end_index) = end {
            return Some(stripped[..end_index].to_string());
        }
    }

    Some(tail.to_string())
}

fn parse_numeric_tail(line: &str, prefix: &str) -> Option<f64> {
    let tail = line.strip_prefix(prefix)?.trim();
    tail.parse::<f64>().ok()
}

fn tokenize_space_separated(line: &str) -> Vec<&str> {
    line.split_whitespace().collect()
}

fn resolve_source_path(root: &Path, value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        return path.to_path_buf();
    }

    root.join(path)
}

#[cfg(test)]
mod tests {
    use super::{detect_external_project_kind, parse_reaper_project, ExternalProjectKind};
    use std::fs;

    #[test]
    fn detects_supported_external_project_extensions() {
        assert_eq!(
            detect_external_project_kind(std::path::Path::new("demo.rpp")),
            Some(ExternalProjectKind::Reaper)
        );
        assert_eq!(
            detect_external_project_kind(std::path::Path::new("demo.als")),
            Some(ExternalProjectKind::Ableton)
        );
        assert_eq!(
            detect_external_project_kind(std::path::Path::new("demo.ltpkg")),
            None
        );
    }

    #[test]
    fn parses_reaper_tracks_and_items() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_path = temp.path().join("demo.rpp");
        let source_path = temp.path().join("audio").join("stem.wav");
        fs::create_dir_all(source_path.parent().expect("audio dir")).expect("mkdir");
        fs::write(&source_path, b"wav").expect("write wav");

        let rpp = r#"
<REAPER_PROJECT 0.1 "6.80/x64" 1710000000
  TEMPO 128 4 4
  <TRACK
    NAME "Pad"
    VOLPAN 0.75 0.1 -1 -1 1
    MUTESOLO 0 0 0
    <ITEM
      POSITION 12.0
      LENGTH 8.0
      SOFFS 0.5
      VOLPAN 0.9 0 0 0 0
      <SOURCE WAVE
        FILE "audio/stem.wav"
      >
    >
  >
>
"#;
        fs::write(&project_path, rpp).expect("write rpp");

        let parsed = parse_reaper_project(&project_path).expect("parse");
        assert_eq!(parsed.bpm, Some(128.0));
        assert_eq!(parsed.time_signature.as_deref(), Some("4/4"));
        assert_eq!(parsed.tracks.len(), 1);
        assert_eq!(parsed.tracks[0].name, "Pad");
        assert_eq!(parsed.tracks[0].items.len(), 1);
        assert_eq!(parsed.tracks[0].items[0].position_seconds, 12.0);
        assert_eq!(parsed.tracks[0].items[0].length_seconds, 8.0);
        assert_eq!(parsed.tracks[0].items[0].source_start_seconds, 0.5);
        assert!(parsed.tracks[0].items[0].source_path.ends_with("audio/stem.wav"));
    }
}
