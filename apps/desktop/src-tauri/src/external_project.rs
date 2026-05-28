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
    pub section_markers: Vec<ReaperSectionMarker>,
    pub regions: Vec<ReaperRegion>,
    pub tempo_markers: Vec<ReaperTempoMarker>,
    pub time_signature_markers: Vec<ReaperTimeSignatureMarker>,
    pub tracks: Vec<ReaperTrack>,
}

#[derive(Debug, Clone)]
pub struct ReaperSectionMarker {
    pub name: String,
    pub start_seconds: f64,
}

#[derive(Debug, Clone)]
pub struct ReaperRegion {
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone)]
pub struct ReaperTempoMarker {
    pub start_seconds: f64,
    pub bpm: f64,
}

#[derive(Debug, Clone)]
pub struct ReaperTimeSignatureMarker {
    pub start_seconds: f64,
    pub signature: String,
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
    let mut section_markers = Vec::<ReaperSectionMarker>::new();
    let mut regions = Vec::<ReaperRegion>::new();
    let mut tempo_markers = Vec::<ReaperTempoMarker>::new();
    let mut time_signature_markers = Vec::<ReaperTimeSignatureMarker>::new();
    let mut tracks = Vec::new();

    let mut current_track: Option<ReaperTrackBuilder> = None;
    let mut current_item: Option<ReaperItemBuilder> = None;
    let mut source_depth = 0_u32;
    let mut tempo_env_depth = 0_u32;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if line.starts_with("<TEMPOENVEX") {
            tempo_env_depth = 1;
            continue;
        }

        if tempo_env_depth > 0 {
            if line.starts_with('<') {
                tempo_env_depth = tempo_env_depth.saturating_add(1);
                continue;
            }

            if line == ">" {
                tempo_env_depth = tempo_env_depth.saturating_sub(1);
                continue;
            }

            if line.starts_with("PT ") {
                if let Some(point) = parse_tempo_env_point(line) {
                    tempo_markers.push(ReaperTempoMarker {
                        start_seconds: point.start_seconds,
                        bpm: point.bpm,
                    });
                    if let Some(signature) = point.signature {
                        time_signature_markers.push(ReaperTimeSignatureMarker {
                            start_seconds: point.start_seconds,
                            signature,
                        });
                    }
                }
            }
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

            if line.starts_with("MARKER ") {
                if let Some(event) = parse_project_marker_line(line) {
                    match event {
                        ReaperProjectMarkerEvent::Section(section) => section_markers.push(section),
                        ReaperProjectMarkerEvent::Region(region) => regions.push(region),
                    }
                }
                continue;
            }

            if line.starts_with("REGION ") {
                if let Some(region) = parse_project_region_line(line) {
                    regions.push(region);
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

    normalize_section_markers(&mut section_markers);
    normalize_regions(&mut regions);
    normalize_tempo_markers(&mut tempo_markers);
    normalize_time_signature_markers(&mut time_signature_markers);

    if bpm.is_none() {
        bpm = tempo_markers
            .iter()
            .find(|marker| marker.start_seconds <= 0.0001)
            .map(|marker| marker.bpm)
            .or_else(|| tempo_markers.first().map(|marker| marker.bpm));
    }
    if time_signature.is_none() {
        time_signature = time_signature_markers
            .iter()
            .find(|marker| marker.start_seconds <= 0.0001)
            .map(|marker| marker.signature.clone())
            .or_else(|| {
                time_signature_markers
                    .first()
                    .map(|marker| marker.signature.clone())
            });
    }

    let duration_seconds = tracks
        .iter()
        .flat_map(|track| track.items.iter())
        .map(|item| item.position_seconds + item.length_seconds)
        .fold(0.0_f64, f64::max)
        .max(
            regions
                .iter()
                .map(|region| region.end_seconds)
                .fold(0.0_f64, f64::max),
        )
        .max(
            section_markers
                .iter()
                .map(|marker| marker.start_seconds)
                .fold(0.0_f64, f64::max),
        )
        .max(
            tempo_markers
                .iter()
                .map(|marker| marker.start_seconds)
                .fold(0.0_f64, f64::max),
        )
        .max(
            time_signature_markers
                .iter()
                .map(|marker| marker.start_seconds)
                .fold(0.0_f64, f64::max),
        )
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
        section_markers,
        regions,
        tempo_markers,
        time_signature_markers,
        tracks,
    })
}

#[derive(Debug, Clone)]
enum ReaperProjectMarkerEvent {
    Section(ReaperSectionMarker),
    Region(ReaperRegion),
}

#[derive(Debug, Clone)]
struct TempoEnvPoint {
    start_seconds: f64,
    bpm: f64,
    signature: Option<String>,
}

fn parse_project_marker_line(line: &str) -> Option<ReaperProjectMarkerEvent> {
    let tokens = tokenize_reaper_line(line);
    if tokens.len() < 4 {
        return None;
    }

    let start_seconds = tokens.get(2)?.parse::<f64>().ok()?.max(0.0);
    let name = tokens
        .get(3)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Marker".to_string());

    let region_flag = tokens
        .get(4)
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0);

    if region_flag == 1 {
        let end_seconds = tokens
            .get(5)
            .and_then(|value| value.parse::<f64>().ok())
            .map(|value| value.max(start_seconds + 0.001))
            .unwrap_or(start_seconds + 0.001);
        return Some(ReaperProjectMarkerEvent::Region(ReaperRegion {
            name,
            start_seconds,
            end_seconds,
        }));
    }

    Some(ReaperProjectMarkerEvent::Section(ReaperSectionMarker {
        name,
        start_seconds,
    }))
}

fn parse_project_region_line(line: &str) -> Option<ReaperRegion> {
    let tokens = tokenize_reaper_line(line);
    if tokens.len() < 5 {
        return None;
    }

    let start_seconds = tokens.get(2)?.parse::<f64>().ok()?.max(0.0);
    let end_seconds = tokens
        .get(3)
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| value.max(start_seconds + 0.001))?;
    let name = tokens
        .get(4)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Region".to_string());

    Some(ReaperRegion {
        name,
        start_seconds,
        end_seconds,
    })
}

fn parse_tempo_env_point(line: &str) -> Option<TempoEnvPoint> {
    let tokens = tokenize_reaper_line(line);
    if tokens.len() < 3 {
        return None;
    }

    let start_seconds = tokens.get(1)?.parse::<f64>().ok()?.max(0.0);
    let bpm = tokens
        .get(2)
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| value.max(20.0))?;
    let signature = extract_time_signature_from_pt(&tokens);

    Some(TempoEnvPoint {
        start_seconds,
        bpm,
        signature,
    })
}

fn extract_time_signature_from_pt(tokens: &[String]) -> Option<String> {
    if tokens.len() < 7 {
        return None;
    }

    for index in 3..tokens.len().saturating_sub(1) {
        let Some(numerator) = tokens.get(index).and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(denominator) = tokens
            .get(index + 1)
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if numerator == 0 || denominator == 0 {
            continue;
        }
        if denominator == 1
            || denominator == 2
            || denominator == 4
            || denominator == 8
            || denominator == 16
            || denominator == 32
        {
            return Some(format!("{numerator}/{denominator}"));
        }
    }

    None
}

fn normalize_section_markers(markers: &mut Vec<ReaperSectionMarker>) {
    markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.name.cmp(&right.name))
    });

    let mut deduped = Vec::<ReaperSectionMarker>::new();
    for marker in markers.drain(..) {
        if deduped.iter().any(|existing| {
            (existing.start_seconds - marker.start_seconds).abs() <= 0.0001
                && existing.name.eq_ignore_ascii_case(&marker.name)
        }) {
            continue;
        }
        deduped.push(marker);
    }
    *markers = deduped;
}

fn normalize_regions(regions: &mut Vec<ReaperRegion>) {
    regions.retain(|region| {
        region.start_seconds.is_finite()
            && region.end_seconds.is_finite()
            && region.end_seconds > region.start_seconds
    });
    regions.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.end_seconds
                    .partial_cmp(&right.end_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut deduped = Vec::<ReaperRegion>::new();
    for region in regions.drain(..) {
        if deduped.iter().any(|existing| {
            (existing.start_seconds - region.start_seconds).abs() <= 0.0001
                && (existing.end_seconds - region.end_seconds).abs() <= 0.0001
                && existing.name.eq_ignore_ascii_case(&region.name)
        }) {
            continue;
        }
        deduped.push(region);
    }
    *regions = deduped;
}

fn normalize_tempo_markers(markers: &mut Vec<ReaperTempoMarker>) {
    markers.retain(|marker| marker.start_seconds.is_finite() && marker.bpm.is_finite());
    markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut deduped = Vec::<ReaperTempoMarker>::new();
    for marker in markers.drain(..) {
        if let Some(existing) = deduped
            .iter_mut()
            .find(|existing| (existing.start_seconds - marker.start_seconds).abs() <= 0.0001)
        {
            existing.bpm = marker.bpm;
            continue;
        }
        deduped.push(marker);
    }
    *markers = deduped;
}

fn normalize_time_signature_markers(markers: &mut Vec<ReaperTimeSignatureMarker>) {
    markers.retain(|marker| {
        marker.start_seconds.is_finite() && parse_time_signature(&marker.signature).is_some()
    });
    markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut deduped = Vec::<ReaperTimeSignatureMarker>::new();
    for marker in markers.drain(..) {
        if let Some(existing) = deduped
            .iter_mut()
            .find(|existing| (existing.start_seconds - marker.start_seconds).abs() <= 0.0001)
        {
            existing.signature = marker.signature;
            continue;
        }
        deduped.push(marker);
    }
    *markers = deduped;
}

fn parse_time_signature(signature: &str) -> Option<(u32, u32)> {
    let (numerator, denominator) = signature.split_once('/')?;
    let numerator = numerator.parse::<u32>().ok()?;
    let denominator = denominator.parse::<u32>().ok()?;
    if numerator == 0 || denominator == 0 {
        return None;
    }
    Some((numerator, denominator))
}

fn tokenize_reaper_line(line: &str) -> Vec<String> {
    let mut tokens = Vec::<String>::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for character in line.chars() {
        match character {
            '"' => {
                in_quotes = !in_quotes;
            }
            ' ' | '\t' if !in_quotes => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
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
    MARKER 1 4.0 "Intro"
    MARKER 2 8.0 "Verse" 1 16.0
    <TEMPOENVEX
        PT 0.0 128.0 1 0 0 4 4
        PT 16.0 132.0 1 0 0 3 4
    >
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
        assert_eq!(parsed.section_markers.len(), 1);
        assert_eq!(parsed.section_markers[0].name, "Intro");
        assert_eq!(parsed.regions.len(), 1);
        assert_eq!(parsed.regions[0].name, "Verse");
        assert_eq!(parsed.regions[0].start_seconds, 8.0);
        assert_eq!(parsed.regions[0].end_seconds, 16.0);
        assert_eq!(parsed.tempo_markers.len(), 2);
        assert_eq!(parsed.tempo_markers[0].start_seconds, 0.0);
        assert_eq!(parsed.tempo_markers[0].bpm, 128.0);
        assert_eq!(parsed.time_signature_markers.len(), 2);
        assert_eq!(parsed.time_signature_markers[1].signature, "3/4");
        assert_eq!(parsed.tracks.len(), 1);
        assert_eq!(parsed.tracks[0].name, "Pad");
        assert_eq!(parsed.tracks[0].items.len(), 1);
        assert_eq!(parsed.tracks[0].items[0].position_seconds, 12.0);
        assert_eq!(parsed.tracks[0].items[0].length_seconds, 8.0);
        assert_eq!(parsed.tracks[0].items[0].source_start_seconds, 0.5);
        assert!(parsed.tracks[0].items[0].source_path.ends_with("audio/stem.wav"));
    }
}
