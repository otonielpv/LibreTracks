use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

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
struct ReaperRegionBoundary {
    name: String,
    start_seconds: f64,
}

#[derive(Debug, Clone)]
pub struct ReaperTrack {
    pub name: String,
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
    pub folder_depth_delta: i32,
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
    folder_depth_delta: i32,
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
            folder_depth_delta: 0,
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
    let mut region_boundaries = Vec::<ReaperRegionBoundary>::new();
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
            if line.starts_with("I_FOLDERDEPTH ") {
                let parts = tokenize_space_separated(line);
                track.folder_depth_delta = parts
                    .get(1)
                    .and_then(|value| value.parse::<i32>().ok())
                    .unwrap_or(0);
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
                        ReaperProjectMarkerEvent::RegionBoundary(boundary) => {
                            region_boundaries.push(boundary)
                        }
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

    let source_duration_seconds = tracks
        .iter()
        .flat_map(|track| track.items.iter())
        .map(|item| item.position_seconds + item.length_seconds)
        .fold(0.0_f64, f64::max)
        .max(1.0);

    if !region_boundaries.is_empty() {
        regions.extend(build_regions_from_boundaries(
            &region_boundaries,
            source_duration_seconds,
        ));
    }

    normalize_regions(&mut regions);
    normalize_section_markers(&mut section_markers);
    filter_region_end_boundary_section_markers(&mut section_markers, &regions);
    normalize_tempo_markers(&mut tempo_markers);
    normalize_time_signature_markers(&mut time_signature_markers);

    // Reaper REGIONs are sections of a single song, not separate songs — same as
    // its MARKERs and the same as Ableton locators. A LibreTracks region is a
    // whole song (a clip may not cross between two), so fold each Reaper region's
    // START into a section marker and collapse to a single song region below.
    // This keeps long continuous clips legal (they used to trip "clip spans the
    // boundary between region X and the next").
    for region in &regions {
        section_markers.push(ReaperSectionMarker {
            name: region.name.clone(),
            start_seconds: region.start_seconds,
        });
    }
    regions.clear();
    normalize_section_markers(&mut section_markers);

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

    let duration_seconds = source_duration_seconds
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

    // One imported project = one song = one region spanning the whole
    // arrangement (the Reaper regions became section markers above).
    let regions = vec![ReaperRegion {
        name: title.clone(),
        start_seconds: 0.0,
        end_seconds: duration_seconds,
    }];

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

pub fn parse_ableton_project(path: &Path) -> Result<ReaperProject, String> {
    let root = path
        .parent()
        .ok_or_else(|| "no se pudo resolver la carpeta del proyecto Ableton".to_string())?;
    let xml = read_ableton_xml(path)?;

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::<u8>::new();

    let mut stack = Vec::<String>::new();
    let mut track_builders = Vec::<AbletonTrackBuilder>::new();
    let mut current_track: Option<AbletonTrackBuilder> = None;
    let mut current_clip: Option<AbletonClipBuilder> = None;
    let mut current_locator: Option<AbletonLocatorBuilder> = None;

    let mut title: Option<String> = None;
    let mut bpm: Option<f64> = None;
    let mut signature_numerator: Option<u32> = None;
    let mut signature_denominator: Option<u32> = None;

    let mut section_markers = Vec::<ReaperSectionMarker>::new();
    let mut tempo_markers = Vec::<ReaperTempoMarker>::new();
    let mut time_signature_markers = Vec::<ReaperTimeSignatureMarker>::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(start)) => {
                let tag = decode_tag_name(start.name().as_ref());
                let attributes = collect_attributes(&start);

                handle_ableton_node(
                    root,
                    &stack,
                    &tag,
                    &attributes,
                    false,
                    &mut title,
                    &mut bpm,
                    &mut signature_numerator,
                    &mut signature_denominator,
                    &mut current_track,
                    &mut current_clip,
                    &mut current_locator,
                    &mut section_markers,
                    &mut tempo_markers,
                    &mut time_signature_markers,
                );

                stack.push(tag);
            }
            Ok(Event::Empty(empty)) => {
                let tag = decode_tag_name(empty.name().as_ref());
                let attributes = collect_attributes(&empty);

                handle_ableton_node(
                    root,
                    &stack,
                    &tag,
                    &attributes,
                    true,
                    &mut title,
                    &mut bpm,
                    &mut signature_numerator,
                    &mut signature_denominator,
                    &mut current_track,
                    &mut current_clip,
                    &mut current_locator,
                    &mut section_markers,
                    &mut tempo_markers,
                    &mut time_signature_markers,
                );
            }
            Ok(Event::End(end)) => {
                let tag = decode_tag_name(end.name().as_ref());
                if tag.eq_ignore_ascii_case("AudioClip") {
                    if let (Some(track), Some(clip)) = (current_track.as_mut(), current_clip.take()) {
                        if let Some(item) = build_ableton_item(clip) {
                            track.items.push(item);
                        }
                    }
                } else if tag.eq_ignore_ascii_case("AudioTrack") {
                    if let Some(track) = current_track.take() {
                        track_builders.push(track);
                    }
                } else if tag.eq_ignore_ascii_case("Locator") {
                    if let Some(locator) = current_locator.take() {
                        if let Some(section) = build_ableton_locator(locator) {
                            section_markers.push(section);
                        }
                    }
                }

                if let Some(last) = stack.pop() {
                    if !last.eq_ignore_ascii_case(&tag) {
                        while let Some(next) = stack.pop() {
                            if next.eq_ignore_ascii_case(&tag) {
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(format!("no se pudo parsear el XML de Ableton: {error}"));
            }
        }

        buffer.clear();
    }

    if let (Some(track), Some(clip)) = (current_track.as_mut(), current_clip.take()) {
        if let Some(item) = build_ableton_item(clip) {
            track.items.push(item);
        }
    }
    if let Some(track) = current_track.take() {
        track_builders.push(track);
    }
    if let Some(locator) = current_locator.take() {
        if let Some(section) = build_ableton_locator(locator) {
            section_markers.push(section);
        }
    }

    let mut tracks = track_builders
        .into_iter()
        .enumerate()
        .map(|(index, builder)| build_ableton_track(builder, index))
        .collect::<Vec<_>>();
    tracks.retain(|track| !track.items.is_empty());

    if tracks.is_empty() {
        return Err("el proyecto Ableton no contiene pistas de audio importables".to_string());
    }

    if let (Some(numerator), Some(denominator)) = (signature_numerator, signature_denominator) {
        time_signature_markers.push(ReaperTimeSignatureMarker {
            start_seconds: 0.0,
            signature: format!("{numerator}/{denominator}"),
        });
    }

    // Resolve the project tempo BEFORE converting any timing. Ableton stores ALL
    // arrangement positions (clip start/end, locator times, tempo/time-signature
    // event times) in BEATS, not seconds — so until now every value above is a
    // beat count. We need the BPM to turn them into seconds.
    if bpm.is_none() {
        bpm = tempo_markers
            .iter()
            .find(|marker| marker.start_seconds <= 0.0001)
            .map(|marker| marker.bpm)
            .or_else(|| tempo_markers.first().map(|marker| marker.bpm));
    }

    // Convert the whole project from beats to seconds. We use the base tempo for
    // the linear mapping `seconds = beats * 60 / bpm`. Tempo automation (a
    // changing BPM across the arrangement) would need piecewise integration of
    // the tempo map; that is a TODO — single-tempo projects (the common case)
    // are exact, variable-tempo projects are approximate but no longer wildly
    // wrong (they used to be off by a factor of `bpm/60`).
    let beats_to_seconds = 60.0 / bpm.unwrap_or(120.0).max(20.0);
    for track in &mut tracks {
        for item in &mut track.items {
            item.position_seconds *= beats_to_seconds;
            item.length_seconds *= beats_to_seconds;
            item.source_start_seconds *= beats_to_seconds;
        }
    }
    for marker in &mut section_markers {
        marker.start_seconds *= beats_to_seconds;
    }
    for marker in &mut tempo_markers {
        marker.start_seconds *= beats_to_seconds;
    }
    for marker in &mut time_signature_markers {
        marker.start_seconds *= beats_to_seconds;
    }

    normalize_section_markers(&mut section_markers);
    normalize_tempo_markers(&mut tempo_markers);
    normalize_time_signature_markers(&mut time_signature_markers);

    let time_signature = time_signature_markers
        .iter()
        .find(|marker| marker.start_seconds <= 0.0001)
        .map(|marker| marker.signature.clone())
        .or_else(|| {
            time_signature_markers
                .first()
                .map(|marker| marker.signature.clone())
        });

    let duration_seconds = tracks
        .iter()
        .flat_map(|track| track.items.iter())
        .map(|item| item.position_seconds + item.length_seconds)
        .fold(0.0_f64, f64::max)
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

    let project_title = title
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Ableton Import".to_string());

    // A LibreTracks `SongRegion` is a whole SONG on the session timeline, and a
    // clip may not straddle the boundary between two of them. Ableton locators
    // are NOT songs — they are section markers (Intro/Verse/Chorus...) inside a
    // single song, and they are already imported as section markers above. So an
    // imported Ableton project is exactly ONE region spanning the whole
    // arrangement; mapping locators to regions would slice the song into pieces
    // that the long, continuous clips then illegally cross.
    let regions = vec![ReaperRegion {
        name: project_title,
        start_seconds: 0.0,
        end_seconds: duration_seconds,
    }];

    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
        })
        .unwrap_or_else(|| "Ableton Import".to_string());

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
struct AbletonTrackBuilder {
    name: Option<String>,
    volume: f64,
    pan: f64,
    muted: bool,
    solo: bool,
    items: Vec<ReaperItem>,
}

impl Default for AbletonTrackBuilder {
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
struct AbletonClipBuilder {
    current_start: Option<f64>,
    current_end: Option<f64>,
    source_start_seconds: Option<f64>,
    gain: f64,
    file_path: Option<PathBuf>,
}

impl Default for AbletonClipBuilder {
    fn default() -> Self {
        Self {
            current_start: None,
            current_end: None,
            source_start_seconds: None,
            gain: 1.0,
            file_path: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct AbletonLocatorBuilder {
    name: Option<String>,
    time: Option<f64>,
}

fn read_ableton_xml(path: &Path) -> Result<String, String> {
    let raw = fs::read(path).map_err(|error| format!("no se pudo leer el archivo .als: {error}"))?;
    if let Ok(xml) = String::from_utf8(raw.clone()) {
        if xml.trim_start().starts_with('<') {
            return Ok(xml);
        }
    }

    let mut decoder = GzDecoder::new(raw.as_slice());
    let mut xml = String::new();
    decoder
        .read_to_string(&mut xml)
        .map_err(|error| format!("no se pudo descomprimir el archivo .als: {error}"))?;
    if xml.trim_start().starts_with('<') {
        Ok(xml)
    } else {
        Err("el archivo .als no contiene XML valido".to_string())
    }
}

fn decode_tag_name(name: &[u8]) -> String {
    let raw = String::from_utf8_lossy(name);
    raw.rsplit(':').next().unwrap_or(raw.as_ref()).to_string()
}

fn collect_attributes(start: &BytesStart<'_>) -> Vec<(String, String)> {
    start
        .attributes()
        .flatten()
        .map(|attribute| {
            (
                String::from_utf8_lossy(attribute.key.as_ref()).to_string(),
                String::from_utf8_lossy(attribute.value.as_ref()).to_string(),
            )
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn handle_ableton_node(
    root: &Path,
    stack: &[String],
    tag: &str,
    attributes: &[(String, String)],
    is_empty: bool,
    title: &mut Option<String>,
    bpm: &mut Option<f64>,
    signature_numerator: &mut Option<u32>,
    signature_denominator: &mut Option<u32>,
    current_track: &mut Option<AbletonTrackBuilder>,
    current_clip: &mut Option<AbletonClipBuilder>,
    current_locator: &mut Option<AbletonLocatorBuilder>,
    section_markers: &mut Vec<ReaperSectionMarker>,
    tempo_markers: &mut Vec<ReaperTempoMarker>,
    time_signature_markers: &mut Vec<ReaperTimeSignatureMarker>,
) {
    if tag.eq_ignore_ascii_case("AudioTrack") {
        *current_track = Some(AbletonTrackBuilder::default());
        return;
    }
    if tag.eq_ignore_ascii_case("AudioClip") {
        *current_clip = Some(AbletonClipBuilder::default());
        return;
    }
    if tag.eq_ignore_ascii_case("Locator") {
        *current_locator = Some(AbletonLocatorBuilder::default());
        return;
    }

    let value = attributes
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("Value"))
        .map(|(_, value)| value.as_str());

    if tag.eq_ignore_ascii_case("FloatEvent") {
        if let (Some(time), Some(marker_bpm)) = (
            attr_f64(attributes, "Time"),
            attr_f64(attributes, "Value").map(|value| value.max(20.0)),
        ) {
            if stack_contains(stack, "TempoAutomation") || stack_contains(stack, "Tempo") {
                tempo_markers.push(ReaperTempoMarker {
                    start_seconds: time.max(0.0),
                    bpm: marker_bpm,
                });
            }
        }
    }

    if tag.eq_ignore_ascii_case("TimeSignatureEvent") {
        let time = attr_f64(attributes, "Time").unwrap_or(0.0).max(0.0);
        let numerator = attr_u32(attributes, "Numerator");
        let denominator = attr_u32(attributes, "Denominator");
        if let (Some(n), Some(d)) = (numerator, denominator) {
            if n > 0 && d > 0 {
                time_signature_markers.push(ReaperTimeSignatureMarker {
                    start_seconds: time,
                    signature: format!("{n}/{d}"),
                });
            }
        }
    }

    if let Some(track) = current_track.as_mut() {
        if let Some(node_value) = value {
            if tag.eq_ignore_ascii_case("EffectiveName") || tag.eq_ignore_ascii_case("UserName") {
                if !node_value.trim().is_empty() {
                    track.name = Some(node_value.trim().to_string());
                }
            }
            if tag.eq_ignore_ascii_case("Manual") && parent_is(stack, "Volume") {
                if let Ok(parsed) = node_value.parse::<f64>() {
                    track.volume = parsed.max(0.0);
                }
            }
            if tag.eq_ignore_ascii_case("Manual") && parent_is(stack, "Pan") {
                if let Ok(parsed) = node_value.parse::<f64>() {
                    track.pan = parsed.clamp(-1.0, 1.0);
                }
            }
            if (tag.eq_ignore_ascii_case("On") || tag.eq_ignore_ascii_case("Mute"))
                && parent_is(stack, "Mixer")
            {
                if let Ok(parsed) = node_value.parse::<f64>() {
                    track.muted = parsed <= 0.0;
                }
            }
            if tag.eq_ignore_ascii_case("Solo") && parent_is(stack, "Mixer") {
                if let Ok(parsed) = node_value.parse::<f64>() {
                    track.solo = parsed > 0.0;
                }
            }
        }
    }

    if let Some(clip) = current_clip.as_mut() {
        if let Some(node_value) = value {
            if tag.eq_ignore_ascii_case("CurrentStart") {
                clip.current_start = node_value.parse::<f64>().ok().map(|value| value.max(0.0));
            } else if tag.eq_ignore_ascii_case("CurrentEnd") {
                clip.current_end = node_value.parse::<f64>().ok().map(|value| value.max(0.0));
            } else if tag.eq_ignore_ascii_case("StartRelative")
                || tag.eq_ignore_ascii_case("SourceStart")
                || tag.eq_ignore_ascii_case("Start")
            {
                clip.source_start_seconds =
                    node_value.parse::<f64>().ok().map(|value| value.max(0.0));
            } else if tag.eq_ignore_ascii_case("Path")
                || tag.eq_ignore_ascii_case("FilePath")
                || tag.eq_ignore_ascii_case("RelativePath")
            {
                if !node_value.trim().is_empty() {
                    clip.file_path = Some(resolve_ableton_path(root, node_value));
                }
            } else if tag.eq_ignore_ascii_case("Manual") && parent_is(stack, "Volume") {
                if let Ok(parsed) = node_value.parse::<f64>() {
                    clip.gain = parsed.max(0.0);
                }
            }
        }
    }

    if let Some(locator) = current_locator.as_mut() {
        if let Some(node_value) = value {
            if tag.eq_ignore_ascii_case("Name") {
                if !node_value.trim().is_empty() {
                    locator.name = Some(node_value.trim().to_string());
                }
            } else if tag.eq_ignore_ascii_case("Time") {
                locator.time = node_value.parse::<f64>().ok().map(|value| value.max(0.0));
            }
        }
    }

    if let Some(node_value) = value {
        if tag.eq_ignore_ascii_case("Manual") && parent_is(stack, "Tempo") {
            if let Ok(parsed) = node_value.parse::<f64>() {
                *bpm = Some(parsed.max(20.0));
            }
        }

        // Project title: a top-level `Name` directly under LiveSet. Guard
        // against the many other `Name` nodes nested under tracks, clips and
        // locators (they all sit under LiveSet too) — otherwise the first
        // locator/track name was being grabbed as the project title.
        if tag.eq_ignore_ascii_case("Name")
            && parent_is(stack, "LiveSet")
            && current_track.is_none()
            && current_clip.is_none()
            && current_locator.is_none()
        {
            if title.is_none() && !node_value.trim().is_empty() {
                *title = Some(node_value.trim().to_string());
            }
        }

        if tag.eq_ignore_ascii_case("Numerator") && stack_contains(stack, "TimeSignature") {
            *signature_numerator = node_value.parse::<u32>().ok().filter(|value| *value > 0);
        }
        if tag.eq_ignore_ascii_case("Denominator") && stack_contains(stack, "TimeSignature") {
            *signature_denominator = node_value.parse::<u32>().ok().filter(|value| *value > 0);
        }
    }

    if is_empty && tag.eq_ignore_ascii_case("Locator") {
        if let Some(locator) = current_locator.take() {
            if let Some(section) = build_ableton_locator(locator) {
                section_markers.push(section);
            }
        }
    }
}

fn build_ableton_item(builder: AbletonClipBuilder) -> Option<ReaperItem> {
    let file_path = builder.file_path?;
    let position_seconds = builder.current_start.unwrap_or(0.0).max(0.0);
    let end_seconds = builder.current_end.unwrap_or(position_seconds);
    let length_seconds = (end_seconds - position_seconds).max(0.0);
    if length_seconds <= 0.0 {
        return None;
    }

    Some(ReaperItem {
        position_seconds,
        length_seconds,
        source_start_seconds: builder.source_start_seconds.unwrap_or(0.0).max(0.0),
        source_path: file_path,
        gain: builder.gain.max(0.0),
        muted: false,
    })
}

fn build_ableton_locator(locator: AbletonLocatorBuilder) -> Option<ReaperSectionMarker> {
    let start_seconds = locator.time?.max(0.0);
    let name = locator
        .name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Marker".to_string());
    Some(ReaperSectionMarker {
        name,
        start_seconds,
    })
}

fn resolve_ableton_path(root: &Path, value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        return path.to_path_buf();
    }
    root.join(path)
}

fn parent_is(stack: &[String], expected_parent: &str) -> bool {
    stack
        .last()
        .map(|parent| parent.eq_ignore_ascii_case(expected_parent))
        .unwrap_or(false)
}

fn stack_contains(stack: &[String], expected: &str) -> bool {
    stack
        .iter()
        .any(|node| node.eq_ignore_ascii_case(expected))
}

fn attr_f64(attributes: &[(String, String)], key: &str) -> Option<f64> {
    attributes
        .iter()
        .find(|(attribute_key, _)| attribute_key.eq_ignore_ascii_case(key))
        .and_then(|(_, value)| value.parse::<f64>().ok())
}

fn attr_u32(attributes: &[(String, String)], key: &str) -> Option<u32> {
    attributes
        .iter()
        .find(|(attribute_key, _)| attribute_key.eq_ignore_ascii_case(key))
        .and_then(|(_, value)| value.parse::<u32>().ok())
}

#[derive(Debug, Clone)]
enum ReaperProjectMarkerEvent {
    Section(ReaperSectionMarker),
    Region(ReaperRegion),
    RegionBoundary(ReaperRegionBoundary),
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
    // The raw name may legitimately be empty: Reaper writes a region's END
    // boundary as `MARKER idx pos "" 1` with no name. Keep the empty string for
    // boundaries so `build_regions_from_boundaries` can tell an end-only boundary
    // (which must not become its own region) from a named region start.
    let raw_name = tokens
        .get(3)
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let name = if raw_name.is_empty() {
        "Marker".to_string()
    } else {
        raw_name.clone()
    };

    let region_flag = tokens
        .get(4)
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0);

    if region_flag == 1 {
        let explicit_end = tokens.get(5).and_then(|value| value.parse::<f64>().ok());
        if let Some(end_seconds) = explicit_end {
            if end_seconds > start_seconds + 0.001 {
                return Some(ReaperProjectMarkerEvent::Region(ReaperRegion {
                    name,
                    start_seconds,
                    end_seconds,
                }));
            }
        }

        return Some(ReaperProjectMarkerEvent::RegionBoundary(ReaperRegionBoundary {
            name: raw_name,
            start_seconds,
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

fn filter_region_end_boundary_section_markers(
    markers: &mut Vec<ReaperSectionMarker>,
    regions: &[ReaperRegion],
) {
    markers.retain(|marker| {
        let trimmed = marker.name.trim();
        if trimmed.is_empty() || !trimmed.chars().all(|character| character.is_ascii_digit()) {
            return true;
        }

        // Some Reaper projects serialize synthetic numeric markers at the
        // same timestamp as a region end. They are not user section markers,
        // so skip importing them to avoid trailing labels like "1".
        !regions
            .iter()
            .any(|region| (region.end_seconds - marker.start_seconds).abs() <= 0.0001)
    });
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

fn build_regions_from_boundaries(
    boundaries: &[ReaperRegionBoundary],
    source_duration_seconds: f64,
) -> Vec<ReaperRegion> {
    let mut sorted = boundaries.to_vec();
    sorted.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut deduped = Vec::<ReaperRegionBoundary>::new();
    for boundary in sorted {
        if let Some(existing) = deduped
            .iter_mut()
            .find(|existing| (existing.start_seconds - boundary.start_seconds).abs() <= 0.0001)
        {
            if existing.name.trim().is_empty() && !boundary.name.trim().is_empty() {
                existing.name = boundary.name;
            }
            continue;
        }
        deduped.push(boundary);
    }

    let mut regions = Vec::<ReaperRegion>::new();
    for (index, boundary) in deduped.iter().enumerate() {
        let next_start = deduped
            .get(index + 1)
            .map(|next| next.start_seconds)
            .unwrap_or(source_duration_seconds)
            .max(boundary.start_seconds + 0.001);

        let has_next = deduped.get(index + 1).is_some();
        if !has_next && boundary.name.trim().is_empty() {
            continue;
        }

        let region_name = if boundary.name.trim().is_empty() {
            format!("Region {}", index + 1)
        } else {
            boundary.name.clone()
        };

        regions.push(ReaperRegion {
            name: region_name,
            start_seconds: boundary.start_seconds.max(0.0),
            end_seconds: next_start,
        });
    }

    regions
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
    // Reaper serializes an empty marker/region name as a bare `""`. We must keep
    // that as an explicit empty token so positional fields after it (e.g. the
    // `isrgn` flag of a region-end boundary `MARKER idx pos "" 1`) stay aligned.
    // Without this, the empty name is dropped, the flag is misread as the name,
    // and the region-end boundary is misparsed as a phantom section marker
    // sitting at the end of the song.
    let mut token_started = false;

    for character in line.chars() {
        match character {
            '"' => {
                in_quotes = !in_quotes;
                token_started = true;
            }
            ' ' | '\t' if !in_quotes => {
                if token_started {
                    tokens.push(std::mem::take(&mut current));
                    token_started = false;
                }
            }
            _ => {
                current.push(character);
                token_started = true;
            }
        }
    }

    if token_started {
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
        folder_depth_delta: builder.folder_depth_delta,
        items: builder.items,
    }
}

fn build_ableton_track(builder: AbletonTrackBuilder, index: usize) -> ReaperTrack {
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
        folder_depth_delta: 0,
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
    use super::{
        detect_external_project_kind, parse_ableton_project, parse_reaper_project,
        tokenize_reaper_line, ExternalProjectKind,
    };
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
        // A Reaper REGION is a section of the song, not a separate song: "Verse"
        // (the explicit region at 8s) becomes a section marker alongside "Intro",
        // and the import is a single full-span region.
        assert_eq!(parsed.section_markers.len(), 2);
        assert!(parsed
            .section_markers
            .iter()
            .any(|m| m.name == "Intro" && (m.start_seconds - 4.0).abs() < 0.0001));
        assert!(parsed
            .section_markers
            .iter()
            .any(|m| m.name == "Verse" && (m.start_seconds - 8.0).abs() < 0.0001));
        assert_eq!(parsed.regions.len(), 1);
        assert_eq!(parsed.regions[0].start_seconds, 0.0);
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
                assert_eq!(parsed.tracks[0].folder_depth_delta, 0);
        }

        #[test]
        fn parses_reaper_folder_depth_hierarchy_markers() {
                let temp = tempfile::tempdir().expect("tempdir");
                let project_path = temp.path().join("demo-folders.rpp");
                let source_path = temp.path().join("audio").join("stem.wav");
                fs::create_dir_all(source_path.parent().expect("audio dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");

                let rpp = r#"
<REAPER_PROJECT 0.1 "7.0/x64" 1710000000
    <TRACK
        NAME "Folder"
        I_FOLDERDEPTH 1
    >
    <TRACK
        NAME "Child"
        I_FOLDERDEPTH -1
        <ITEM
            POSITION 1.0
            LENGTH 2.0
            <SOURCE WAVE
                FILE "audio/stem.wav"
            >
        >
    >
>
"#;
                fs::write(&project_path, rpp).expect("write rpp");

                let parsed = parse_reaper_project(&project_path).expect("parse");
                assert_eq!(parsed.tracks.len(), 2);
                assert_eq!(parsed.tracks[0].name, "Folder");
                assert_eq!(parsed.tracks[0].folder_depth_delta, 1);
                assert_eq!(parsed.tracks[1].name, "Child");
                assert_eq!(parsed.tracks[1].folder_depth_delta, -1);
                assert_eq!(parsed.tracks[1].items.len(), 1);
    }

        #[test]
        fn parses_reaper_region_boundaries_without_explicit_end_times() {
                let temp = tempfile::tempdir().expect("tempdir");
                let project_path = temp.path().join("demo-boundaries.rpp");
                let source_path = temp.path().join("audio").join("stem.wav");
                fs::create_dir_all(source_path.parent().expect("audio dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");

                let rpp = r#"
<REAPER_PROJECT 0.1 "7.09/win64" 1779953811
    TEMPO 130 4 4
    MARKER 1 0 "Song Name" 1 0 1 R {AAAA} 0
    MARKER 1 252.92307692307693 "" 1
    MARKER 2 12.92307692307692 Intro 0 0 1 R {BBBB} 0
    MARKER 3 31.38461538461538 Verso 0 0 1 R {CCCC} 0
    MARKER 4 252.92307692307693 "1" 0 0 1 R {DDDD} 0
    <TRACK
        NAME "CLICK"
        <ITEM
            POSITION 0
            LENGTH 252.93697916666665
            SOFFS 0
            VOLPAN 1 0 0 0 0
            <SOURCE MP3
                FILE "audio/stem.wav" 1
            >
        >
    >
>
"#;
                fs::write(&project_path, rpp).expect("write rpp");

                let parsed = parse_reaper_project(&project_path).expect("parse");
                assert_eq!(parsed.bpm, Some(130.0));
                // Reaper regions become section markers: "Song Name" (the region at
                // 0), plus the two MARKERs "Intro" and "Verso". The phantom numeric
                // "1" at the region end must still be filtered out.
                assert!(parsed
                    .section_markers
                    .iter()
                    .any(|marker| marker.name == "Intro"));
                assert!(parsed
                    .section_markers
                    .iter()
                    .any(|marker| marker.name == "Verso"));
                assert!(parsed
                    .section_markers
                    .iter()
                    .any(|marker| marker.name == "Song Name"));
                assert!(
                    !parsed
                        .section_markers
                        .iter()
                        .any(|marker| marker.name.trim() == "1")
                );
                // One full-span song region (regions are not separate songs).
                assert_eq!(parsed.regions.len(), 1);
                assert!((parsed.regions[0].start_seconds - 0.0).abs() < 0.0001);
        }

        #[test]
        fn region_end_boundary_does_not_leak_a_marker_at_song_end() {
                // Regression for the "a marker appears at the very end of the song
                // for no reason" bug. Reaper serializes a region as a start line and
                // an END boundary line `MARKER idx pos "" 1` whose name is an empty
                // quoted string. The tokenizer used to drop the empty `""`, which
                // shifted the columns so the isrgn flag was read as the name and the
                // end boundary was imported as a phantom section marker sitting at
                // the song's end. There must be NO section marker at the region end.
                let temp = tempfile::tempdir().expect("tempdir");
                let project_path = temp.path().join("region-end.rpp");
                let source_path = temp.path().join("audio").join("stem.wav");
                fs::create_dir_all(source_path.parent().expect("audio dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");

                let rpp = r#"
<REAPER_PROJECT 0.1 "7.09/win64" 1779953811
    TEMPO 120 4 4
    MARKER 1 0 "Cancion" 1 0 1 R {AAAA} 0
    MARKER 1 180.0 "" 1
    MARKER 2 8.0 "Estrofa" 0 0 1 R {BBBB} 0
    <TRACK
        NAME "GUIA"
        <ITEM
            POSITION 0
            LENGTH 181.5
            SOFFS 0
            VOLPAN 1 0 0 0 0
            <SOURCE WAVE
                FILE "audio/stem.wav" 1
            >
        >
    >
>
"#;
                fs::write(&project_path, rpp).expect("write rpp");

                let parsed = parse_reaper_project(&project_path).expect("parse");

                // The user section "Estrofa" survives. "Cancion" (the region) is now
                // a section marker at 0. Crucially there is NO phantom marker at/near
                // the region end (180.0 / item length 181.5) — that was the bug.
                assert!(parsed
                    .section_markers
                    .iter()
                    .any(|marker| marker.name == "Estrofa"
                        && (marker.start_seconds - 8.0).abs() < 0.0001));
                assert!(
                    !parsed
                        .section_markers
                        .iter()
                        .any(|marker| marker.start_seconds >= 179.0),
                    "no section marker should land at/after the region end"
                );

                // One full-span song region.
                assert_eq!(parsed.regions.len(), 1);
                assert!((parsed.regions[0].start_seconds - 0.0).abs() < 0.0001);
        }

        #[test]
        fn tokenizer_preserves_explicit_empty_quoted_token() {
                // The empty `""` must survive as a token so columns stay aligned.
                let tokens = tokenize_reaper_line(r#"MARKER 1 180.0 "" 1"#);
                assert_eq!(tokens, vec!["MARKER", "1", "180.0", "", "1"]);
        }

        #[test]
        fn parses_ableton_tracks_and_locators() {
                let temp = tempfile::tempdir().expect("tempdir");
                let project_path = temp.path().join("demo.als");
                let source_path = temp.path().join("audio").join("stem.wav");
                fs::create_dir_all(source_path.parent().expect("audio dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");

                let als = r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton>
    <LiveSet>
        <MasterTrack>
            <Mixer>
                <Tempo>
                    <Manual Value="123.0"/>
                </Tempo>
            </Mixer>
        </MasterTrack>
        <Locators>
            <Locator>
                <Name Value="Intro"/>
                <Time Value="4.0"/>
            </Locator>
            <Locator>
                <Name Value="Verse"/>
                <Time Value="12.0"/>
            </Locator>
        </Locators>
        <Tracks>
            <AudioTrack>
                <Name>
                    <EffectiveName Value="Pad"/>
                </Name>
                <DeviceChain>
                    <Mixer>
                        <Volume><Manual Value="0.75"/></Volume>
                        <Pan><Manual Value="0.1"/></Pan>
                        <On Value="1"/>
                        <Solo Value="0"/>
                    </Mixer>
                    <MainSequencer>
                        <ClipTimeable>
                            <ArrangerAutomation>
                                <Events>
                                    <AudioClip>
                                        <CurrentStart Value="8.0"/>
                                        <CurrentEnd Value="16.0"/>
                                        <StartRelative Value="0.5"/>
                                        <SampleRef>
                                            <FileRef>
                                                <Path Value="audio/stem.wav"/>
                                            </FileRef>
                                        </SampleRef>
                                    </AudioClip>
                                </Events>
                            </ArrangerAutomation>
                        </ClipTimeable>
                    </MainSequencer>
                </DeviceChain>
            </AudioTrack>
        </Tracks>
    </LiveSet>
</Ableton>
"#;
                fs::write(&project_path, als).expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse ableton");
                assert_eq!(parsed.bpm, Some(123.0));
                assert_eq!(parsed.tracks.len(), 1);
                assert_eq!(parsed.tracks[0].name, "Pad");
                assert_eq!(parsed.tracks[0].items.len(), 1);
                // Ableton positions are in BEATS. At 123 BPM one beat is 60/123 s,
                // so the clip at beat 8 lands at 8 * 60/123 ≈ 3.902 s and its 8-beat
                // length is ≈ 3.902 s. Asserting seconds (not beats) is the whole
                // point — the importer must apply the beats→seconds conversion.
                let beat = 60.0 / 123.0;
                assert!(
                    (parsed.tracks[0].items[0].position_seconds - 8.0 * beat).abs() < 0.001,
                    "clip start should be converted from beats to seconds, got {}",
                    parsed.tracks[0].items[0].position_seconds
                );
                assert!(
                    (parsed.tracks[0].items[0].length_seconds - 8.0 * beat).abs() < 0.001,
                    "clip length should be converted from beats to seconds, got {}",
                    parsed.tracks[0].items[0].length_seconds
                );
                // Locators are imported as SECTION MARKERS, not regions.
                assert_eq!(parsed.section_markers.len(), 2);
                assert_eq!(parsed.section_markers[0].name, "Intro");
                // Locator at beat 4 → 4 * 60/123 ≈ 1.951 s.
                assert!(
                    (parsed.section_markers[0].start_seconds - 4.0 * beat).abs() < 0.001,
                    "locator time should be converted from beats to seconds, got {}",
                    parsed.section_markers[0].start_seconds
                );
                // An imported project is ONE song = ONE region spanning the whole
                // arrangement. Locators are sections inside it, not separate songs,
                // so a long clip never straddles a region boundary.
                assert_eq!(parsed.regions.len(), 1);
                assert!(parsed.regions[0].start_seconds <= 0.0001);
                let clip = &parsed.tracks[0].items[0];
                assert!(
                    clip.position_seconds >= parsed.regions[0].start_seconds - 0.0001
                        && clip.position_seconds + clip.length_seconds
                            <= parsed.regions[0].end_seconds + 0.0001,
                    "the whole clip must lie inside the single region"
                );
        }

        #[test]
        fn ableton_reads_gzip_compressed_als() {
                // A real `.als` saved by Live is gzip-compressed, not plain XML.
                // The importer must transparently decompress it.
                use flate2::write::GzEncoder;
                use flate2::Compression;
                use std::io::Write;

                let temp = tempfile::tempdir().expect("tempdir");
                let project_path = temp.path().join("compressed.als");
                let source_path = temp.path().join("audio").join("kick.wav");
                fs::create_dir_all(source_path.parent().expect("audio dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");

                let als = r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="11.0_11300" Creator="Ableton Live 11.3">
    <LiveSet>
        <MasterTrack>
            <DeviceChain><Mixer><Tempo><Manual Value="120.0"/></Tempo></Mixer></DeviceChain>
        </MasterTrack>
        <Tracks>
            <AudioTrack>
                <Name><EffectiveName Value="Drums"/></Name>
                <DeviceChain>
                    <MainSequencer><Sample><ArrangerAutomation><Events>
                        <AudioClip>
                            <CurrentStart Value="0"/>
                            <CurrentEnd Value="8"/>
                            <SampleRef><FileRef><Path Value="audio/kick.wav"/></FileRef></SampleRef>
                        </AudioClip>
                    </Events></ArrangerAutomation></Sample></MainSequencer>
                </DeviceChain>
            </AudioTrack>
        </Tracks>
    </LiveSet>
</Ableton>
"#;

                let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
                encoder.write_all(als.as_bytes()).expect("gzip write");
                let compressed = encoder.finish().expect("gzip finish");
                fs::write(&project_path, compressed).expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse gzip ableton");
                assert_eq!(parsed.bpm, Some(120.0));
                assert_eq!(parsed.tracks.len(), 1);
                assert_eq!(parsed.tracks[0].name, "Drums");
                assert_eq!(parsed.tracks[0].items.len(), 1);
                // 8 beats at 120 BPM = 8 * 0.5 = 4.0 s.
                assert!(
                    (parsed.tracks[0].items[0].length_seconds - 4.0).abs() < 0.001,
                    "got {}",
                    parsed.tracks[0].items[0].length_seconds
                );
        }

        #[test]
        fn ableton_import_is_one_region_so_long_clips_never_cross_a_boundary() {
                use flate2::write::GzEncoder;
                use flate2::Compression;
                use std::io::Write;
                // Regression for two related engine rejections:
                //   1. "clip ... falls outside every region" (a clip at 0s with the
                //      first locator placed later), and
                //   2. "clip ... spans the boundary between region X and the next"
                //      (a long continuous clip crossing locator-derived regions).
                // Both came from treating Ableton locators as regions. Locators are
                // SECTION markers inside one song, so an import is a single region
                // spanning the whole arrangement and a long clip stays whole.
                let temp = tempfile::tempdir().expect("tempdir");
                let project_path = temp.path().join("late-locator.als");
                let source_path = temp.path().join("audio").join("bass.wav");
                fs::create_dir_all(source_path.parent().expect("audio dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");

                // Locators at beats 16 and 32 (i.e. NOT at 0). A clip sits at beat 0.
                let als = r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="11.0_11300" Creator="Ableton Live 11.3">
    <LiveSet>
        <MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="120.0"/></Tempo></Mixer></DeviceChain></MasterTrack>
        <Locators><Locators>
            <Locator><Name Value="Verse"/><Time Value="16"/></Locator>
            <Locator><Name Value="Chorus"/><Time Value="32"/></Locator>
        </Locators></Locators>
        <Tracks>
            <AudioTrack>
                <Name><EffectiveName Value="Bass"/></Name>
                <DeviceChain><MainSequencer><Sample><ArrangerAutomation><Events>
                    <AudioClip>
                        <CurrentStart Value="0"/>
                        <CurrentEnd Value="48"/>
                        <SampleRef><FileRef><Path Value="audio/bass.wav"/></FileRef></SampleRef>
                    </AudioClip>
                </Events></ArrangerAutomation></Sample></MainSequencer></DeviceChain>
            </AudioTrack>
        </Tracks>
    </LiveSet>
</Ableton>
"#;
                let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
                encoder.write_all(als.as_bytes()).expect("gzip write");
                fs::write(&project_path, encoder.finish().expect("gzip finish"))
                    .expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse ableton");

                // The clip runs 0..24s (48 beats at 120 BPM).
                let clip = &parsed.tracks[0].items[0];
                assert!((clip.position_seconds - 0.0).abs() < 0.001);
                assert!((clip.length_seconds - 24.0).abs() < 0.001);

                // The two locators are section markers, not regions.
                assert_eq!(parsed.section_markers.len(), 2);

                // Exactly one region, spanning the whole arrangement, so the entire
                // 0..24s clip lies inside it without crossing any boundary.
                assert_eq!(parsed.regions.len(), 1);
                assert!(parsed.regions[0].start_seconds <= 0.0001);
                assert!(
                    clip.position_seconds + clip.length_seconds
                        <= parsed.regions[0].end_seconds + 0.0001,
                    "the whole clip must lie inside the single region; region ends at {}",
                    parsed.regions[0].end_seconds
                );
        }
}
