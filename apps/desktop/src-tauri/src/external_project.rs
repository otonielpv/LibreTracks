use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

use libretracks_core::MidiEventKind;

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
    /// MIDI clips on this track (Ableton `MidiTrack`, Reaper inline MIDI items).
    pub midi_items: Vec<ExternalMidiItem>,
    /// Output channel (1-16) the source DAW routed this track to, if it said.
    pub midi_channel: Option<u8>,
    /// Output port name the source DAW routed this track to, if it said.
    pub midi_port: Option<String>,
}

impl ReaperTrack {
    /// Whether the track carries anything to import (audio or MIDI). A track
    /// with neither is a group/folder header.
    pub fn has_content(&self) -> bool {
        !self.items.is_empty() || !self.midi_items.is_empty()
    }
}

/// A MIDI clip read from another DAW, already in seconds. `events[].at_seconds`
/// is an offset from `position_seconds`, like [`libretracks_core::MidiEvent`].
#[derive(Debug, Clone)]
pub struct ExternalMidiItem {
    pub name: String,
    pub position_seconds: f64,
    pub length_seconds: f64,
    pub events: Vec<ExternalMidiEvent>,
}

#[derive(Debug, Clone)]
pub struct ExternalMidiEvent {
    pub at_seconds: f64,
    /// Channel (1-16) the source event carried. `None` = the track's.
    pub channel: Option<u8>,
    pub kind: MidiEventKind,
}

impl ExternalMidiItem {
    /// Multiplies every time in the item (Ableton reads in beats first).
    fn scale_time(&mut self, factor: f64) {
        self.position_seconds *= factor;
        self.length_seconds *= factor;
        for event in &mut self.events {
            event.at_seconds *= factor;
            match &mut event.kind {
                MidiEventKind::Note {
                    duration_seconds, ..
                }
                | MidiEventKind::ControlCurve {
                    duration_seconds, ..
                } => *duration_seconds *= factor,
                MidiEventKind::ControlChange { .. } | MidiEventKind::ProgramChange { .. } => {}
            }
        }
    }
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
    first_item_name: Option<String>,
    midi_items: Vec<ReaperPendingMidi>,
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
            first_item_name: None,
            midi_items: Vec::new(),
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
    name: Option<String>,
    loop_source: bool,
    midi: Option<ReaperMidiSource>,
    /// Inside the `<SOURCE MIDI` block currently being read.
    in_midi_source: bool,
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
            name: None,
            loop_source: false,
            midi: None,
            in_midi_source: false,
        }
    }
}

/// An inline `<SOURCE MIDI` as read: event times in ticks from the source
/// start. Turned into seconds once the whole tempo map is known.
#[derive(Debug, Clone)]
struct ReaperMidiSource {
    ticks_per_quarter: f64,
    /// `IGNTEMPO 1 <bpm>`: the source keeps its own tempo, not the project's.
    own_bpm: Option<f64>,
    ticks: u64,
    events: Vec<ReaperMidiRawEvent>,
    /// Notes switched on and not yet off: (channel, note, start tick, velocity).
    open_notes: Vec<(u8, u8, u64, u8)>,
}

#[derive(Debug, Clone)]
struct ReaperMidiRawEvent {
    tick: u64,
    channel: u8,
    /// Note length in ticks; `0` for instantaneous messages.
    duration_ticks: u64,
    kind: MidiEventKind,
}

/// A Reaper MIDI item waiting for the tempo map.
#[derive(Debug, Clone)]
struct ReaperPendingMidi {
    name: String,
    position_seconds: f64,
    length_seconds: f64,
    source_offset_seconds: f64,
    loop_source: bool,
    source: ReaperMidiSource,
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
    let mut pending_midi = Vec::<Vec<ReaperPendingMidi>>::new();

    let mut current_track: Option<ReaperTrackBuilder> = None;
    let mut current_item: Option<ReaperItemBuilder> = None;
    let mut source_depth = 0_u32;
    let mut tempo_env_depth = 0_u32;
    let mut other_block_depth = 0_u32;

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

        if other_block_depth > 0 {
            if line.starts_with('<') {
                other_block_depth = other_block_depth.saturating_add(1);
            } else if line == ">" {
                other_block_depth -= 1;
            }
            continue;
        }

        if line.starts_with("<TRACK") {
            if let Some(track) = current_track.take() {
                pending_midi.push(track.midi_items.clone());
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
            if let Some(item) = current_item.as_mut() {
                let is_midi = tokenize_space_separated(line)
                    .get(1)
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("MIDI"));
                // Only the first MIDI take of an item is read.
                if source_depth == 1 && is_midi && item.midi.is_none() {
                    item.in_midi_source = true;
                    item.midi = Some(ReaperMidiSource {
                        ticks_per_quarter: 960.0,
                        own_bpm: None,
                        ticks: 0,
                        events: Vec::new(),
                        open_notes: Vec::new(),
                    });
                }
            }
            continue;
        }

        // Any other block opened inside a source (`<X` sysex/text events in a
        // MIDI source) closes with its own `>`; without counting it that `>`
        // closed the source early.
        if source_depth > 0 && line.starts_with('<') {
            source_depth = source_depth.saturating_add(1);
            if let Some(midi) = current_item
                .as_mut()
                .filter(|item| item.in_midi_source)
                .and_then(|item| item.midi.as_mut())
            {
                if let Some(delta) = tokenize_space_separated(line)
                    .get(1)
                    .and_then(|value| value.parse::<u64>().ok())
                {
                    midi.ticks = midi.ticks.saturating_add(delta);
                }
            }
            continue;
        }

        // Any other block (`<FXCHAIN`, `<VOLENV2`, `<METRONOME`...) is skipped
        // whole. Its closing `>` used to be read as the end of the track, so
        // every item after a track's FX chain was dropped.
        if line.starts_with('<') && !line.starts_with("<REAPER_PROJECT") {
            other_block_depth = 1;
            continue;
        }

        if line == ">" {
            if source_depth > 0 {
                source_depth -= 1;
                if source_depth == 0 {
                    if let Some(item) = current_item.as_mut() {
                        if item.in_midi_source {
                            item.in_midi_source = false;
                            if let Some(midi) = item.midi.as_mut() {
                                close_open_reaper_notes(midi);
                            }
                        }
                    }
                }
                continue;
            }

            if let Some(item_builder) = current_item.take() {
                if let Some(track) = current_track.as_mut() {
                    push_reaper_item(track, item_builder);
                }
                continue;
            }

            if let Some(track) = current_track.take() {
                pending_midi.push(track.midi_items.clone());
                tracks.push(build_track(track, tracks.len()));
                continue;
            }

            continue;
        }

        if let Some(track) = current_track.as_mut() {
            if let Some(item) = current_item.as_mut() {
                if source_depth > 0 {
                    if item.in_midi_source {
                        if let Some(midi) = item.midi.as_mut() {
                            parse_reaper_midi_source_line(midi, line);
                        }
                        continue;
                    }
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
                if line.starts_with("LOOPSRC ") {
                    item.loop_source = tokenize_space_separated(line)
                        .get(1)
                        .and_then(|value| value.parse::<i32>().ok())
                        .is_some_and(|value| value != 0);
                    continue;
                }
                // The take name. Before, it fell through to the track's NAME
                // below and renamed the track after its last item.
                if line.starts_with("NAME ") {
                    item.name = parse_quoted_or_tail(line, "NAME");
                    continue;
                }
                continue;
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
        if let Some(track) = current_track.as_mut() {
            push_reaper_item(track, item_builder);
        }
    }
    if let Some(track) = current_track.take() {
        pending_midi.push(track.midi_items.clone());
        tracks.push(build_track(track, tracks.len()));
    }

    if tracks.is_empty() {
        return Err("el proyecto Reaper no contiene pistas importables".to_string());
    }

    {
        let mut tempo_points = tempo_markers.clone();
        normalize_tempo_markers(&mut tempo_points);
        let tempo_map = TempoMap::new(&tempo_points, bpm.unwrap_or(120.0));
        for (track, pending) in tracks.iter_mut().zip(pending_midi) {
            track.midi_items = pending
                .into_iter()
                .filter_map(|item| convert_reaper_midi_item(item, &tempo_map))
                .collect();
            track.midi_channel = most_common_event_channel(&track.midi_items);
        }
    }

    let source_duration_seconds = tracks
        .iter()
        .flat_map(|track| {
            track
                .items
                .iter()
                .map(|item| item.position_seconds + item.length_seconds)
                .chain(
                    track
                        .midi_items
                        .iter()
                        .map(|item| item.position_seconds + item.length_seconds),
                )
        })
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

    // A Reaper REGION is a whole song on the setlist (a clip may not cross
    // between two regions), so each REGION is imported as its own SongRegion at
    // its original position. Reaper MARKERs (no end) stay as section markers
    // INSIDE a song. If the project has no regions at all, `regions` is empty and
    // import_reaper_project wraps the whole thing in a single full-span song.
    // (Ableton has no regions, so parse_ableton_project always collapses to one.)

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

    // `regions` carries the real Reaper REGIONs (one SongRegion per song), or is
    // empty when the project only has MARKERs — import_reaper_project then wraps
    // it in a single full-span region.

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
    let mut current_midi_clip: Option<AbletonMidiClipBuilder> = None;
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
                    &mut current_midi_clip,
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
                    &mut current_midi_clip,
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
                        if let Some(item) = build_ableton_item(root, clip) {
                            track.items.push(item);
                        }
                    }
                } else if tag.eq_ignore_ascii_case("MidiClip") {
                    if let (Some(track), Some(clip)) =
                        (current_track.as_mut(), current_midi_clip.take())
                    {
                        if let Some(item) = build_ableton_midi_item(clip) {
                            track.midi_items.push(item);
                        }
                    }
                } else if tag.eq_ignore_ascii_case("AudioTrack")
                    || tag.eq_ignore_ascii_case("MidiTrack")
                {
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
        if let Some(item) = build_ableton_item(root, clip) {
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

    // Resolve the project tempo BEFORE converting any timing. Ableton stores the
    // arrangement positions (clip start/end, locator times, tempo/time-signature
    // event times) in BEATS, not seconds — so until now every value above is a
    // beat count (except an unwarped clip's audio markers, see `AbletonItem`).
    // We need the BPM to turn them into seconds.
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
    for track in &mut track_builders {
        for entry in &mut track.items {
            entry.item.position_seconds *= beats_to_seconds;
            if !entry.audio_in_seconds {
                entry.item.length_seconds *= beats_to_seconds;
                entry.item.source_start_seconds *= beats_to_seconds;
            }
        }
        for item in &mut track.midi_items {
            item.scale_time(beats_to_seconds);
        }
    }

    let mut tracks = track_builders
        .into_iter()
        .enumerate()
        .map(|(index, builder)| build_ableton_track(builder, index))
        .collect::<Vec<_>>();
    tracks.retain(ReaperTrack::has_content);

    if tracks.is_empty() {
        return Err("el proyecto Ableton no contiene pistas de audio ni MIDI importables".to_string());
    }

    if let (Some(numerator), Some(denominator)) = (signature_numerator, signature_denominator) {
        time_signature_markers.push(ReaperTimeSignatureMarker {
            start_seconds: 0.0,
            signature: format!("{numerator}/{denominator}"),
        });
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
        .flat_map(|track| {
            track
                .items
                .iter()
                .map(|item| item.position_seconds + item.length_seconds)
                .chain(
                    track
                        .midi_items
                        .iter()
                        .map(|item| item.position_seconds + item.length_seconds),
                )
        })
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
    items: Vec<AbletonItem>,
    /// MIDI clips, still in beats until the tempo is known.
    midi_items: Vec<ExternalMidiItem>,
    midi_routing: AbletonMidiRouting,
}

/// `<MidiOutputRouting>` of a MIDI track: where Live sent it.
#[derive(Debug, Clone, Default)]
struct AbletonMidiRouting {
    target: Option<String>,
    upper: Option<String>,
    lower: Option<String>,
}

impl AbletonMidiRouting {
    /// The external port name, only when the track really goes out to a
    /// device (not "No Output" nor another track).
    fn port(&self) -> Option<String> {
        let target = self.target.as_deref()?;
        if !target.starts_with("MidiOut/External") {
            return None;
        }
        self.upper
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
    }

    /// "Ch. 3" -> 3. "All Channels" (or a localized label without a number)
    /// leaves the channel to the default.
    fn channel(&self) -> Option<u8> {
        self.port()?;
        let digits = self
            .lower
            .as_deref()?
            .chars()
            .filter(char::is_ascii_digit)
            .collect::<String>();
        digits.parse::<u8>().ok().filter(|ch| (1..=16).contains(ch))
    }
}

/// A `<MidiClip>` in the arrangement as read (all times in beats).
#[derive(Debug, Clone, Default)]
struct AbletonMidiClipBuilder {
    current_start: Option<f64>,
    current_end: Option<f64>,
    loop_on: bool,
    loop_start: Option<f64>,
    loop_end: Option<f64>,
    start_relative: f64,
    name: Option<String>,
    disabled: bool,
    bank_coarse: Option<i32>,
    bank_fine: Option<i32>,
    program: Option<i32>,
    /// (key, time, duration, velocity), clip-relative beats.
    notes: Vec<(u8, f64, f64, u8)>,
    /// Key of the `<KeyTrack>` being read; Live writes it AFTER its notes.
    key_track_key: Option<u8>,
    key_track_pending: Vec<(f64, f64, u8)>,
}

/// A clip as read, before the beats -> seconds pass (the tempo comes after
/// the tracks in the file). The arrangement position is always in beats; the
/// length and the source offset are beats too, except for an unwarped clip,
/// whose markers Live keeps in seconds of the audio file.
#[derive(Debug, Clone)]
struct AbletonItem {
    item: ReaperItem,
    audio_in_seconds: bool,
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
            midi_items: Vec::new(),
            midi_routing: AbletonMidiRouting::default(),
        }
    }
}

#[derive(Debug, Clone)]
struct AbletonClipBuilder {
    current_start: Option<f64>,
    current_end: Option<f64>,
    source_start_seconds: Option<f64>,
    gain: f64,
    file_refs: Vec<AbletonFileRef>,
    is_warped: Option<bool>,
    loop_on: bool,
    loop_start: Option<f64>,
    loop_end: Option<f64>,
    start_relative: f64,
}

impl Default for AbletonClipBuilder {
    fn default() -> Self {
        Self {
            current_start: None,
            current_end: None,
            source_start_seconds: None,
            gain: 1.0,
            file_refs: Vec::new(),
            is_warped: None,
            loop_on: false,
            loop_start: None,
            loop_end: None,
            start_relative: 0.0,
        }
    }
}

/// One `<FileRef>` as Live wrote it. Live has stored the path in two shapes:
///
/// - Live 11+: `<RelativePath Value="Samples/x.wav"/>` plus an absolute
///   `<Path Value="/Users/autor/.../x.wav"/>` from the machine that saved it.
/// - Live 9/10: `<RelativePath>` holds `<RelativePathElement Dir="..."/>`
///   children and the file name lives in a sibling `<Name Value="x.wav"/>`.
///
/// The absolute path only exists on the author's machine, so nothing here is
/// trusted until it is checked against the disk (see `resolve_ableton_clip_path`).
#[derive(Debug, Clone, Default)]
struct AbletonFileRef {
    relative_value: Option<String>,
    absolute_value: Option<String>,
    relative_dirs: Vec<String>,
    name: Option<String>,
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
            // Live escapes `&`, `'`, `"`, `<`, `>` in values. Paths are values,
            // so "Dios & Rey/Bass.wav" arrives as "Dios &amp; Rey/Bass.wav" and
            // the raw bytes name a file that does not exist.
            let value = attribute
                .unescape_value()
                .map(|value| value.into_owned())
                .unwrap_or_else(|_| String::from_utf8_lossy(attribute.value.as_ref()).to_string());
            (
                String::from_utf8_lossy(attribute.key.as_ref()).to_string(),
                value,
            )
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn handle_ableton_node(
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
    current_midi_clip: &mut Option<AbletonMidiClipBuilder>,
    current_locator: &mut Option<AbletonLocatorBuilder>,
    section_markers: &mut Vec<ReaperSectionMarker>,
    tempo_markers: &mut Vec<ReaperTempoMarker>,
    time_signature_markers: &mut Vec<ReaperTimeSignatureMarker>,
) {
    if tag.eq_ignore_ascii_case("AudioTrack") || tag.eq_ignore_ascii_case("MidiTrack") {
        *current_track = Some(AbletonTrackBuilder::default());
        return;
    }
    // Only arrangement clips: Session View clip slots hold MidiClips too, but
    // they are not on the timeline.
    if tag.eq_ignore_ascii_case("MidiClip") {
        if current_track.is_some() && stack_contains(stack, "ArrangerAutomation") {
            *current_midi_clip = Some(AbletonMidiClipBuilder::default());
        }
        return;
    }
    if let Some(clip) = current_midi_clip.as_mut() {
        handle_ableton_midi_clip_node(clip, stack, tag, attributes);
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
            if parent_is(stack, "MidiOutputRouting") {
                let slot = if tag.eq_ignore_ascii_case("Target") {
                    Some(&mut track.midi_routing.target)
                } else if tag.eq_ignore_ascii_case("UpperDisplayString") {
                    Some(&mut track.midi_routing.upper)
                } else if tag.eq_ignore_ascii_case("LowerDisplayString") {
                    Some(&mut track.midi_routing.lower)
                } else {
                    None
                };
                if let Some(slot) = slot {
                    *slot = Some(node_value.to_string());
                }
            }
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
        if tag.eq_ignore_ascii_case("FileRef") {
            clip.file_refs.push(AbletonFileRef::default());
        }
        // Live 9/10: the folders of the relative path, one element each. The
        // `PathHint` under `SearchHint` uses the same element for the author's
        // absolute folders, so only the ones directly under `RelativePath` count.
        if tag.eq_ignore_ascii_case("RelativePathElement") && parent_is(stack, "RelativePath") {
            if let Some((_, dir)) = attributes
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("Dir"))
            {
                current_file_ref(clip).relative_dirs.push(dir.clone());
            }
        }
        if let Some(node_value) = value {
            if parent_is(stack, "Loop") {
                let number = node_value.parse::<f64>().ok();
                if tag.eq_ignore_ascii_case("LoopStart") {
                    clip.loop_start = number;
                } else if tag.eq_ignore_ascii_case("LoopEnd") {
                    clip.loop_end = number;
                } else if tag.eq_ignore_ascii_case("StartRelative") {
                    clip.start_relative = number.unwrap_or(0.0);
                } else if tag.eq_ignore_ascii_case("LoopOn") {
                    clip.loop_on = node_value.eq_ignore_ascii_case("true");
                }
            }
            if tag.eq_ignore_ascii_case("IsWarped") && parent_is(stack, "AudioClip") {
                clip.is_warped = Some(node_value.eq_ignore_ascii_case("true"));
            }
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
            } else if tag.eq_ignore_ascii_case("Path") || tag.eq_ignore_ascii_case("FilePath") {
                if !node_value.trim().is_empty() {
                    current_file_ref(clip).absolute_value = Some(node_value.to_string());
                }
            } else if tag.eq_ignore_ascii_case("RelativePath") {
                if !node_value.trim().is_empty() {
                    current_file_ref(clip).relative_value = Some(node_value.to_string());
                }
            } else if tag.eq_ignore_ascii_case("Name") && parent_is(stack, "FileRef") {
                if !node_value.trim().is_empty() {
                    current_file_ref(clip).name = Some(node_value.to_string());
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

fn build_ableton_item(root: &Path, builder: AbletonClipBuilder) -> Option<AbletonItem> {
    let file_path = resolve_ableton_clip_path(root, &builder.file_refs)?;
    let position = builder.current_start.unwrap_or(0.0).max(0.0);

    // An unwarped clip plays its file at its own speed, whatever the tempo:
    // its start and end markers are seconds of the audio, and with the loop
    // off they are exactly what plays. Live 8 sets (the MultiTracks packs)
    // even write `CurrentEnd` in those seconds; read as beats, every stem was
    // cut at `seconds * 60 / bpm` (a 70 bpm song lost its last 46 s).
    if builder.is_warped == Some(false) && !builder.loop_on {
        if let (Some(loop_start), Some(loop_end)) = (builder.loop_start, builder.loop_end) {
            let source_start = (loop_start + builder.start_relative).max(0.0);
            let length = loop_end - source_start;
            if length > 0.0 {
                return Some(AbletonItem {
                    item: ReaperItem {
                        position_seconds: position,
                        length_seconds: length,
                        source_start_seconds: source_start,
                        source_path: file_path,
                        gain: builder.gain.max(0.0),
                        muted: false,
                    },
                    audio_in_seconds: true,
                });
            }
        }
    }

    let end = builder.current_end.unwrap_or(position);
    let length = (end - position).max(0.0);
    if length <= 0.0 {
        return None;
    }

    Some(AbletonItem {
        item: ReaperItem {
            position_seconds: position,
            length_seconds: length,
            source_start_seconds: builder.source_start_seconds.unwrap_or(0.0).max(0.0),
            source_path: file_path,
            gain: builder.gain.max(0.0),
            muted: false,
        },
        audio_in_seconds: false,
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

fn current_file_ref(clip: &mut AbletonClipBuilder) -> &mut AbletonFileRef {
    if clip.file_refs.is_empty() {
        clip.file_refs.push(AbletonFileRef::default());
    }
    clip.file_refs.last_mut().expect("file ref just ensured")
}

/// Pick the clip's audio file. A `.als` that travelled from another computer
/// (the usual case: a multitrack downloaded from the internet) carries the
/// author's absolute path, which does not exist here, so the candidates are
/// tried in order of how portable they are and the first one on disk wins:
/// relative to the project folder first, the absolute path last. If none
/// exists, the file name is looked up inside the project folder, where Live
/// keeps `Samples/` and where downloaded packs keep their stems.
///
/// When nothing is found the first candidate is still returned, so the import
/// reports the file as missing instead of silently dropping the track.
fn resolve_ableton_clip_path(root: &Path, file_refs: &[AbletonFileRef]) -> Option<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();
    let mut file_names = Vec::<String>::new();

    for file_ref in file_refs {
        if let Some(relative) = file_ref.relative_value.as_deref() {
            candidates.push(join_ableton_path(root, relative));
        }
        if let Some(name) = file_ref.name.as_deref() {
            let mut path = root.to_path_buf();
            for dir in &file_ref.relative_dirs {
                match dir.as_str() {
                    "" | "." => {}
                    ".." => {
                        path.pop();
                    }
                    other => path.push(other),
                }
            }
            candidates.push(path.join(name));
            file_names.push(name.to_string());
        }
        if let Some(absolute) = file_ref.absolute_value.as_deref() {
            candidates.push(join_ableton_path(root, absolute));
        }
        for value in [
            file_ref.relative_value.as_deref(),
            file_ref.absolute_value.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            // The value may be a Windows path read on macOS (or the reverse),
            // where `Path::file_name` would not split it: cut on both separators.
            if let Some(name) = value.rsplit(['/', '\\']).next().filter(|name| !name.is_empty()) {
                file_names.push(name.to_string());
            }
        }
    }

    if let Some(existing) = candidates.iter().find(|candidate| candidate.is_file()) {
        return Some(existing.clone());
    }
    for name in &file_names {
        if let Some(found) = find_file_by_name(root, name, ABLETON_SEARCH_MAX_DEPTH) {
            return Some(found);
        }
    }
    candidates.into_iter().next()
}

fn join_ableton_path(root: &Path, value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        return path.to_path_buf();
    }
    root.join(value.replace('\\', "/"))
}

const ABLETON_SEARCH_MAX_DEPTH: usize = 4;

fn find_file_by_name(dir: &Path, name: &str, depth_left: usize) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            subdirs.push(path);
        } else if entry
            .file_name()
            .to_str()
            .map(|entry_name| entry_name.eq_ignore_ascii_case(name))
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    if depth_left == 0 {
        return None;
    }
    subdirs.sort();
    subdirs
        .iter()
        .find_map(|subdir| find_file_by_name(subdir, name, depth_left - 1))
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
            .or_else(|| {
                builder
                    .first_item_name
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
            })
            .unwrap_or_else(|| format!("Track {}", index + 1)),
        volume: builder.volume.max(0.0),
        pan: builder.pan.clamp(-1.0, 1.0),
        muted: builder.muted,
        solo: builder.solo,
        folder_depth_delta: builder.folder_depth_delta,
        items: builder.items,
        // Filled in after the tempo map is read (see parse_reaper_project).
        midi_items: Vec::new(),
        midi_channel: None,
        midi_port: None,
    }
}

fn push_reaper_item(track: &mut ReaperTrackBuilder, mut builder: ReaperItemBuilder) {
    if track.first_item_name.is_none() {
        track.first_item_name = builder.name.clone();
    }
    if let Some(midi) = builder.midi.take() {
        if !builder.muted && builder.length_seconds > 0.0 && !midi.events.is_empty() {
            track.midi_items.push(ReaperPendingMidi {
                name: builder.name.clone().unwrap_or_default(),
                position_seconds: builder.position_seconds.max(0.0),
                length_seconds: builder.length_seconds,
                source_offset_seconds: builder.source_start_seconds.max(0.0),
                loop_source: builder.loop_source,
                source: midi,
            });
        }
        return;
    }
    if let Some(item) = build_item(builder) {
        track.items.push(item);
    }
}

fn build_ableton_track(builder: AbletonTrackBuilder, index: usize) -> ReaperTrack {
    // Multitrack packs often leave Live's automatic "1-Audio" or "1-Click"
    // and only the stems carry the instrument, so the file name is the better
    // track name there.
    let stem_name = builder
        .items
        .first()
        .and_then(|entry| entry.item.source_path.file_stem())
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.trim().to_string())
        .filter(|stem| !stem.is_empty());
    ReaperTrack {
        name: builder
            .name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .filter(|name| {
                stem_name
                    .as_deref()
                    .map_or(true, |stem| !is_ableton_default_track_name(name, stem))
            })
            .or(stem_name)
            .unwrap_or_else(|| format!("Track {}", index + 1)),
        volume: builder.volume.max(0.0),
        pan: builder.pan.clamp(-1.0, 1.0),
        muted: builder.muted,
        solo: builder.solo,
        folder_depth_delta: 0,
        items: builder.items.into_iter().map(|entry| entry.item).collect(),
        midi_channel: builder.midi_routing.channel(),
        midi_port: builder.midi_routing.port(),
        midi_items: builder.midi_items,
    }
}

fn handle_ableton_midi_clip_node(
    clip: &mut AbletonMidiClipBuilder,
    stack: &[String],
    tag: &str,
    attributes: &[(String, String)],
) {
    if tag.eq_ignore_ascii_case("KeyTrack") {
        clip.key_track_key = None;
        clip.key_track_pending.clear();
        return;
    }
    if tag.eq_ignore_ascii_case("MidiNoteEvent") {
        let enabled = attributes
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("IsEnabled"))
            .map_or(true, |(_, value)| !value.eq_ignore_ascii_case("false"));
        let (Some(time), Some(duration)) =
            (attr_f64(attributes, "Time"), attr_f64(attributes, "Duration"))
        else {
            return;
        };
        if !enabled || duration <= 0.0 {
            return;
        }
        let velocity = attr_f64(attributes, "Velocity")
            .unwrap_or(100.0)
            .round()
            .clamp(1.0, 127.0) as u8;
        match clip.key_track_key {
            Some(key) => clip.notes.push((key, time, duration, velocity)),
            None => clip.key_track_pending.push((time, duration, velocity)),
        }
        return;
    }

    let Some(value) = attributes
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("Value"))
        .map(|(_, value)| value.as_str())
    else {
        return;
    };
    if tag.eq_ignore_ascii_case("MidiKey") && parent_is(stack, "KeyTrack") {
        if let Ok(key) = value.parse::<i32>() {
            let key = key.clamp(0, 127) as u8;
            clip.key_track_key = Some(key);
            for (time, duration, velocity) in clip.key_track_pending.drain(..) {
                clip.notes.push((key, time, duration, velocity));
            }
        }
        return;
    }
    if parent_is(stack, "Loop") {
        let number = value.parse::<f64>().ok();
        if tag.eq_ignore_ascii_case("LoopStart") {
            clip.loop_start = number;
        } else if tag.eq_ignore_ascii_case("LoopEnd") {
            clip.loop_end = number;
        } else if tag.eq_ignore_ascii_case("StartRelative") {
            clip.start_relative = number.unwrap_or(0.0);
        } else if tag.eq_ignore_ascii_case("LoopOn") {
            clip.loop_on = value.eq_ignore_ascii_case("true");
        }
        return;
    }
    if !parent_is(stack, "MidiClip") {
        return;
    }
    if tag.eq_ignore_ascii_case("CurrentStart") {
        clip.current_start = value.parse::<f64>().ok();
    } else if tag.eq_ignore_ascii_case("CurrentEnd") {
        clip.current_end = value.parse::<f64>().ok();
    } else if tag.eq_ignore_ascii_case("Name") {
        clip.name = Some(value.trim().to_string()).filter(|name| !name.is_empty());
    } else if tag.eq_ignore_ascii_case("Disabled") {
        clip.disabled = value.eq_ignore_ascii_case("true");
    } else if tag.eq_ignore_ascii_case("BankSelectCoarse") {
        clip.bank_coarse = value.parse::<i32>().ok();
    } else if tag.eq_ignore_ascii_case("BankSelectFine") {
        clip.bank_fine = value.parse::<i32>().ok();
    } else if tag.eq_ignore_ascii_case("ProgramChange") {
        clip.program = value.parse::<i32>().ok();
    }
}

/// Lays an arrangement MIDI clip out on the timeline (still in beats): the
/// notes that fall inside the visible part, repeated when the clip loops.
fn build_ableton_midi_item(clip: AbletonMidiClipBuilder) -> Option<ExternalMidiItem> {
    if clip.disabled {
        return None;
    }
    let position = clip.current_start?.max(0.0);
    let length = clip.current_end? - position;
    if length <= 0.0 {
        return None;
    }
    let loop_start = clip.loop_start.unwrap_or(0.0);
    let loop_end = clip.loop_end.unwrap_or(loop_start + length);
    let looping = clip.loop_on && loop_end > loop_start + 1e-6;
    let content_start = loop_start + if looping { clip.start_relative } else { 0.0 };

    let mut events = Vec::new();
    // Live's clip "Bank/Sub/Pgm" boxes: sent when the clip starts. -1 = off.
    let data = |value: Option<i32>| value.filter(|v| (0..=127).contains(v)).map(|v| v as u8);
    if let Some(value) = data(clip.bank_coarse) {
        events.push(ExternalMidiEvent {
            at_seconds: 0.0,
            channel: None,
            kind: MidiEventKind::ControlChange {
                controller: 0,
                value,
            },
        });
    }
    if let Some(value) = data(clip.bank_fine) {
        events.push(ExternalMidiEvent {
            at_seconds: 0.0,
            channel: None,
            kind: MidiEventKind::ControlChange {
                controller: 32,
                value,
            },
        });
    }
    if let Some(program) = data(clip.program) {
        events.push(ExternalMidiEvent {
            at_seconds: 0.0,
            channel: None,
            kind: MidiEventKind::ProgramChange { program },
        });
    }

    let mut notes = clip.notes;
    notes.sort_by(|a, b| a.1.total_cmp(&b.1));
    // Each pass plays clip time [window_start, window_end) starting at
    // timeline offset `offset`. Without loop there is one pass up to the end
    // marker (LoopEnd doubles as it when the loop is off).
    let mut window_start = content_start;
    let mut offset = 0.0_f64;
    while offset < length && events.len() < MAX_IMPORTED_MIDI_EVENTS_PER_CLIP {
        let window_end = if looping { loop_end } else { content_start + length };
        for &(key, time, duration, velocity) in &notes {
            if time < window_start - 1e-9 || time >= window_end {
                continue;
            }
            let at = offset + (time - window_start);
            if at >= length {
                break;
            }
            let until = (offset + (time + duration).min(window_end) - window_start).min(length);
            events.push(ExternalMidiEvent {
                at_seconds: at,
                channel: None,
                kind: MidiEventKind::Note {
                    note: key,
                    velocity,
                    duration_seconds: (until - at).max(1e-3),
                },
            });
        }
        if !looping {
            break;
        }
        offset += window_end - window_start;
        window_start = loop_start;
    }

    if events.is_empty() {
        return None;
    }
    Some(ExternalMidiItem {
        name: clip.name.unwrap_or_default(),
        position_seconds: position,
        length_seconds: length,
        events,
    })
}

/// Live's automatic audio track names: `<number>-Audio` for an empty track,
/// `<number>-<stem>` once a file is dropped on it.
fn is_ableton_default_track_name(name: &str, stem: &str) -> bool {
    name.split_once('-')
        .map(|(number, rest)| {
            !number.is_empty()
                && number.chars().all(|c| c.is_ascii_digit())
                && (rest.eq_ignore_ascii_case("Audio") || rest.eq_ignore_ascii_case(stem))
        })
        .unwrap_or(false)
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

/// One line inside a Reaper `<SOURCE MIDI` block. Events are
/// `E <delta ticks> <status> <data1> <data2>` in hex (`e` = selected, an `m`
/// in the flag = muted); the delta always advances the clock, muted or not.
fn parse_reaper_midi_source_line(midi: &mut ReaperMidiSource, line: &str) {
    let parts = tokenize_space_separated(line);
    let Some(flag) = parts.first() else {
        return;
    };
    if *flag == "HASDATA" {
        if let Some(ppq) = parts.get(2).and_then(|value| value.parse::<f64>().ok()) {
            if ppq > 0.0 {
                midi.ticks_per_quarter = ppq;
            }
        }
        return;
    }
    if *flag == "IGNTEMPO" {
        let ignores = parts.get(1).is_some_and(|value| *value == "1");
        midi.own_bpm = if ignores {
            parts
                .get(2)
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|bpm| *bpm > 0.0)
        } else {
            None
        };
        return;
    }
    let is_event = flag.starts_with('E') || flag.starts_with('e');
    if !is_event || flag.len() > 3 || !flag.chars().all(|c| c.is_ascii_alphabetic()) {
        return;
    }
    let Some(delta) = parts.get(1).and_then(|value| value.parse::<u64>().ok()) else {
        return;
    };
    midi.ticks = midi.ticks.saturating_add(delta);
    if flag[1..].contains('m') {
        return;
    }
    let hex = |index: usize| {
        parts
            .get(index)
            .and_then(|value| u8::from_str_radix(value, 16).ok())
    };
    let (Some(status), Some(data1)) = (hex(2), hex(3)) else {
        return;
    };
    let data2 = hex(4).unwrap_or(0);
    let channel = (status & 0x0f) + 1;
    let tick = midi.ticks;
    match status & 0xf0 {
        0x90 if data2 > 0 => {
            close_reaper_note(midi, channel, data1, tick);
            midi.open_notes.push((channel, data1 & 0x7f, tick, data2 & 0x7f));
        }
        0x80 | 0x90 => close_reaper_note(midi, channel, data1, tick),
        // CC 123 (all notes off) is how Reaper marks the end of the source.
        0xb0 if data1 == 123 => {}
        0xb0 => midi.events.push(ReaperMidiRawEvent {
            tick,
            channel,
            duration_ticks: 0,
            kind: MidiEventKind::ControlChange {
                controller: data1 & 0x7f,
                value: data2 & 0x7f,
            },
        }),
        0xc0 => midi.events.push(ReaperMidiRawEvent {
            tick,
            channel,
            duration_ticks: 0,
            kind: MidiEventKind::ProgramChange {
                program: data1 & 0x7f,
            },
        }),
        _ => {}
    }
}

fn close_reaper_note(midi: &mut ReaperMidiSource, channel: u8, note: u8, tick: u64) {
    let note = note & 0x7f;
    if let Some(index) = midi
        .open_notes
        .iter()
        .position(|(ch, n, _, _)| *ch == channel && *n == note)
    {
        let (_, _, start, velocity) = midi.open_notes.remove(index);
        midi.events.push(ReaperMidiRawEvent {
            tick: start,
            channel,
            duration_ticks: tick.saturating_sub(start),
            kind: MidiEventKind::Note {
                note,
                velocity,
                duration_seconds: 0.0,
            },
        });
    }
}

/// Notes still held when the source ends last until its end.
fn close_open_reaper_notes(midi: &mut ReaperMidiSource) {
    let end = midi.ticks;
    while let Some((channel, note, _, _)) = midi.open_notes.first().copied() {
        close_reaper_note(midi, channel, note, end);
    }
    midi.events.sort_by_key(|event| event.tick);
}

/// Piecewise-constant tempo map (ramps are read as steps), for turning a
/// position in seconds into beats and back.
struct TempoMap {
    /// (start seconds, start beat, bpm), sorted.
    segments: Vec<(f64, f64, f64)>,
}

impl TempoMap {
    fn new(markers: &[ReaperTempoMarker], base_bpm: f64) -> Self {
        let mut segments = vec![(0.0, 0.0, base_bpm.max(1.0))];
        for marker in markers {
            let (sec, beat, bpm) = *segments.last().unwrap();
            let start = marker.start_seconds.max(0.0);
            if start <= sec + 1e-9 {
                segments.last_mut().unwrap().2 = marker.bpm.max(1.0);
                continue;
            }
            segments.push((start, beat + (start - sec) * bpm / 60.0, marker.bpm.max(1.0)));
        }
        Self { segments }
    }

    fn seconds_to_beats(&self, seconds: f64) -> f64 {
        let (sec, beat, bpm) = self
            .segments
            .iter()
            .rev()
            .find(|(sec, _, _)| *sec <= seconds)
            .copied()
            .unwrap_or(self.segments[0]);
        beat + (seconds - sec) * bpm / 60.0
    }

    fn beats_to_seconds(&self, beats: f64) -> f64 {
        let (sec, beat, bpm) = self
            .segments
            .iter()
            .rev()
            .find(|(_, beat, _)| *beat <= beats)
            .copied()
            .unwrap_or(self.segments[0]);
        sec + (beats - beat) * 60.0 / bpm
    }
}

/// Upper bound on events produced by repeating a looped clip, so a tiny loop
/// stretched over a long item cannot balloon the session.
const MAX_IMPORTED_MIDI_EVENTS_PER_CLIP: usize = 20_000;

fn convert_reaper_midi_item(item: ReaperPendingMidi, tempo: &TempoMap) -> Option<ExternalMidiItem> {
    let source = &item.source;
    let ppq = source.ticks_per_quarter.max(1.0);
    let start = item.position_seconds;
    let end = start + item.length_seconds;
    // Source time (quarter notes from the source start) -> project seconds.
    // A source with its own tempo plays at that tempo whatever the project's.
    let start_beat = tempo.seconds_to_beats(start);
    let item_beats = tempo.seconds_to_beats(end) - start_beat;
    let (offset_beats, to_seconds): (f64, Box<dyn Fn(f64) -> f64 + '_>) = match source.own_bpm {
        Some(bpm) => (
            item.source_offset_seconds * bpm / 60.0,
            Box::new(move |beats| start + beats * 60.0 / bpm),
        ),
        None => (
            tempo.seconds_to_beats(start + item.source_offset_seconds) - start_beat,
            Box::new(move |beats| tempo.beats_to_seconds(start_beat + beats)),
        ),
    };
    let length_beats = match source.own_bpm {
        Some(bpm) => item.length_seconds * bpm / 60.0,
        None => item_beats,
    };
    let source_beats = source.ticks as f64 / ppq;
    let period = if item.loop_source && source_beats > 1e-6 {
        Some(source_beats)
    } else {
        None
    };

    let mut events = Vec::new();
    let mut pass = 0_u32;
    'passes: loop {
        let pass_offset = period.map_or(0.0, |period| f64::from(pass) * period) - offset_beats;
        if pass_offset >= length_beats {
            break;
        }
        for raw in &source.events {
            let at = raw.tick as f64 / ppq + pass_offset;
            if at < -1e-9 {
                continue;
            }
            if at >= length_beats {
                break;
            }
            let at_seconds = (to_seconds(at) - start).max(0.0);
            let kind = match raw.kind.clone() {
                MidiEventKind::Note { note, velocity, .. } => {
                    let until = (at + raw.duration_ticks as f64 / ppq).min(length_beats);
                    let note_end = period.map_or(until, |period| {
                        until.min(pass_offset + period)
                    });
                    MidiEventKind::Note {
                        note,
                        velocity: velocity.max(1),
                        duration_seconds: (to_seconds(note_end) - start - at_seconds).max(0.001),
                    }
                }
                other => other,
            };
            events.push(ExternalMidiEvent {
                at_seconds,
                channel: Some(raw.channel),
                kind,
            });
            if events.len() >= MAX_IMPORTED_MIDI_EVENTS_PER_CLIP {
                break 'passes;
            }
        }
        if period.is_none() {
            break;
        }
        pass += 1;
    }

    if events.is_empty() {
        return None;
    }
    Some(ExternalMidiItem {
        name: item.name,
        position_seconds: start,
        length_seconds: item.length_seconds,
        events,
    })
}

/// The channel most of a track's events use, so it becomes the track's
/// channel and only the odd ones out keep a per-event override.
fn most_common_event_channel(items: &[ExternalMidiItem]) -> Option<u8> {
    let mut counts = [0_usize; 17];
    for event in items.iter().flat_map(|item| item.events.iter()) {
        if let Some(channel) = event.channel.filter(|ch| (1..=16).contains(ch)) {
            counts[usize::from(channel)] += 1;
        }
    }
    let (channel, count) = counts
        .iter()
        .enumerate()
        .max_by_key(|(channel, count)| (**count, std::cmp::Reverse(*channel)))?;
    (*count > 0).then_some(channel as u8)
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
        detect_external_project_kind, is_ableton_default_track_name, parse_ableton_project,
        parse_reaper_project, tokenize_reaper_line, ExternalProjectKind,
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
        // A Reaper REGION is its own song; a plain MARKER is a section inside a
        // song. "Verse" (the explicit region at 8→16) becomes a SongRegion;
        // "Intro" (a marker) becomes a section marker.
        assert_eq!(parsed.section_markers.len(), 1);
        assert_eq!(parsed.section_markers[0].name, "Intro");
        assert_eq!(parsed.section_markers[0].start_seconds, 4.0);
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
                // "Song Name" is a REGION → its own song. "Intro"/"Verso" are
                // MARKERs → sections. The phantom numeric "1" at the region end
                // must still be filtered out (the empty-quoted-token fix).
                assert_eq!(parsed.section_markers.len(), 2);
                assert_eq!(parsed.section_markers[0].name, "Intro");
                assert!(parsed
                    .section_markers
                    .iter()
                    .any(|marker| marker.name == "Verso"));
                assert!(
                    !parsed
                        .section_markers
                        .iter()
                        .any(|marker| marker.name.trim() == "1")
                );
                // The region "Song Name" is preserved with its real bounds.
                assert_eq!(parsed.regions.len(), 1);
                assert_eq!(parsed.regions[0].name, "Song Name");
                assert!((parsed.regions[0].start_seconds - 0.0).abs() < 0.0001);
                assert!((parsed.regions[0].end_seconds - 252.92307692307693).abs() < 0.001);
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

                // "Cancion" is a REGION → its own song. "Estrofa" is a MARKER →
                // a section. Crucially there is NO phantom marker at/near the
                // region end (180.0 / item length 181.5) — that was the bug.
                assert_eq!(parsed.section_markers.len(), 1);
                assert_eq!(parsed.section_markers[0].name, "Estrofa");
                assert!((parsed.section_markers[0].start_seconds - 8.0).abs() < 0.0001);
                assert!(
                    !parsed
                        .section_markers
                        .iter()
                        .any(|marker| marker.start_seconds >= 179.0),
                    "no section marker should land at/after the region end"
                );

                // The region "Cancion" is preserved (0 → end boundary 180.0).
                assert_eq!(parsed.regions.len(), 1);
                assert_eq!(parsed.regions[0].name, "Cancion");
                assert!((parsed.regions[0].start_seconds - 0.0).abs() < 0.0001);
                assert!((parsed.regions[0].end_seconds - 180.0).abs() < 0.001);
        }

        #[test]
        fn parses_reaper_multiple_regions_as_separate_songs() {
                // A .rpp setlist: two explicit REGIONs (each a song) plus a plain
                // MARKER acting as a section inside the first one. The regions must
                // come through as two SongRegions at their original positions; the
                // marker stays a section marker.
                let temp = tempfile::tempdir().expect("tempdir");
                let project_path = temp.path().join("setlist.rpp");
                let source_path = temp.path().join("audio").join("stem.wav");
                fs::create_dir_all(source_path.parent().expect("audio dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");

                let rpp = r#"
<REAPER_PROJECT 0.1 "7.0/x64" 1710000000
    TEMPO 120 4 4
    MARKER 1 0 "Tema A" 1 0 1 R {AAAA} 0
    MARKER 1 100.0 "" 1
    MARKER 2 20.0 "Verso" 0 0 1 R {BBBB} 0
    MARKER 3 100.0 "Tema B" 1 0 1 R {CCCC} 0
    MARKER 3 200.0 "" 1
    <TRACK
        NAME "GUIA"
        <ITEM
            POSITION 0
            LENGTH 200.0
            SOFFS 0
            <SOURCE WAVE
                FILE "audio/stem.wav"
            >
        >
    >
>
"#;
                fs::write(&project_path, rpp).expect("write rpp");

                let parsed = parse_reaper_project(&project_path).expect("parse");

                // Two songs, in order, at their original positions.
                assert_eq!(parsed.regions.len(), 2);
                assert_eq!(parsed.regions[0].name, "Tema A");
                assert!((parsed.regions[0].start_seconds - 0.0).abs() < 0.001);
                assert!((parsed.regions[0].end_seconds - 100.0).abs() < 0.001);
                assert_eq!(parsed.regions[1].name, "Tema B");
                assert!((parsed.regions[1].start_seconds - 100.0).abs() < 0.001);
                assert!((parsed.regions[1].end_seconds - 200.0).abs() < 0.001);

                // The lone MARKER "Verso" is a section, not a song.
                assert!(parsed
                    .section_markers
                    .iter()
                    .any(|marker| marker.name == "Verso"
                        && (marker.start_seconds - 20.0).abs() < 0.001));
                assert!(!parsed
                    .section_markers
                    .iter()
                    .any(|marker| marker.name == "Tema A" || marker.name == "Tema B"));
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

        fn ableton_set_with_file_ref(file_ref: &str) -> String {
                format!(
                        r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton>
    <LiveSet>
        <Tracks>
            <AudioTrack>
                <Name><EffectiveName Value="Click Track"/></Name>
                <DeviceChain><MainSequencer><Sample><ArrangerAutomation><Events>
                    <AudioClip Time="0">
                        <CurrentStart Value="0"/>
                        <CurrentEnd Value="8"/>
                        <Name Value="Click Track"/>
                        <SampleRef>{file_ref}</SampleRef>
                    </AudioClip>
                </Events></ArrangerAutomation></Sample></MainSequencer></DeviceChain>
            </AudioTrack>
        </Tracks>
    </LiveSet>
</Ableton>
"#
                )
        }

        #[test]
        fn ableton_live10_relative_path_elements_resolve_the_stem() {
                // Live 9/10 has no `<Path Value>`: the folders are
                // `RelativePathElement`s and the file name is the FileRef's
                // `<Name>`. The `PathHint` holds the AUTHOR's folders with the
                // same element and must not leak into the path. Before the fix
                // every clip came out without a file and the whole import failed
                // with "no contiene pistas de audio importables".
                let temp = tempfile::tempdir().expect("tempdir");
                let source_path = temp.path().join("MultiTracks").join("Click Track.wav");
                fs::create_dir_all(source_path.parent().expect("dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");
                let project_path = temp.path().join("song.als");
                fs::write(
                        &project_path,
                        ableton_set_with_file_ref(
                                r#"<FileRef>
                                <HasRelativePath Value="true"/>
                                <RelativePathType Value="1"/>
                                <RelativePath>
                                    <RelativePathElement Id="3" Dir=""/>
                                    <RelativePathElement Id="4" Dir="MultiTracks"/>
                                </RelativePath>
                                <Name Value="Click Track.wav"/>
                                <SearchHint><PathHint>
                                    <RelativePathElement Id="11" Dir="Root"/>
                                    <RelativePathElement Id="12" Dir="Descargas"/>
                                </PathHint></SearchHint>
                            </FileRef>"#,
                        ),
                )
                .expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse ableton");
                assert_eq!(parsed.tracks.len(), 1);
                assert_eq!(parsed.tracks[0].items[0].source_path, source_path);
        }

        #[test]
        fn ableton_unescapes_xml_entities_in_paths() {
                // Live 12 writes the path of a folder named "Dios & Rey's" as
                // `Dios &amp; Rey&apos;s`. Read raw, no candidate existed and the
                // import failed with "io error: No such file or directory".
                let temp = tempfile::tempdir().expect("tempdir");
                let folder = temp.path().join("Dios & Rey's");
                let source_path = folder.join("Bass & Keys.wav");
                fs::create_dir_all(&folder).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");
                let project_path = temp.path().join("song.als");
                let absolute = source_path
                        .to_string_lossy()
                        .replace('&', "&amp;")
                        .replace('\'', "&apos;");
                fs::write(
                        &project_path,
                        ableton_set_with_file_ref(&format!(
                                r#"<FileRef>
                                <RelativePathType Value="3"/>
                                <RelativePath Value="Dios &amp; Rey&apos;s/Bass &amp; Keys.wav"/>
                                <Path Value="{absolute}"/>
                            </FileRef>"#
                        )),
                )
                .expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse ableton");
                assert_eq!(parsed.tracks[0].items[0].source_path, source_path);
        }

        #[test]
        fn ableton_default_track_name_falls_back_to_the_stem_name() {
                assert!(is_ableton_default_track_name("1-Audio", "Bass"));
                assert!(is_ableton_default_track_name("12-Audio", "Bass"));
                // Live 12 after dropping "Click.m4a" on track 1.
                assert!(is_ableton_default_track_name("1-Click", "Click"));
                assert!(!is_ableton_default_track_name("Bass", "Bass"));
                assert!(!is_ableton_default_track_name("1-MIDI", "Bass"));
                assert!(!is_ableton_default_track_name("1-Click", "Bass"));
                assert!(!is_ableton_default_track_name("Audio", "Bass"));

                let temp = tempfile::tempdir().expect("tempdir");
                let source_path = temp.path().join("Click Track.wav");
                fs::write(&source_path, b"wav").expect("write wav");
                let project_path = temp.path().join("song.als");
                let als = ableton_set_with_file_ref(
                        r#"<FileRef><RelativePath Value="Click Track.wav"/></FileRef>"#,
                )
                .replace(r#"<EffectiveName Value="Click Track"/>"#, r#"<EffectiveName Value="1-Audio"/>"#);
                fs::write(&project_path, als).expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse ableton");
                assert_eq!(parsed.tracks[0].name, "Click Track");
        }

        #[test]
        fn ableton_prefers_existing_relative_path_over_authors_absolute_path() {
                // Live 11+ writes both; the absolute one is the author's machine
                // and came AFTER the relative one, so it used to win and the
                // import died with "No such file or directory (os error 2)".
                let temp = tempfile::tempdir().expect("tempdir");
                let source_path = temp.path().join("Samples").join("Imported").join("Bass.wav");
                fs::create_dir_all(source_path.parent().expect("dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");
                let project_path = temp.path().join("song.als");
                fs::write(
                        &project_path,
                        ableton_set_with_file_ref(
                                r#"<FileRef>
                                <RelativePathType Value="3"/>
                                <RelativePath Value="Samples/Imported/Bass.wav"/>
                                <Path Value="/Users/autor/Music/Proyecto/Samples/Imported/Bass.wav"/>
                            </FileRef>"#,
                        ),
                )
                .expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse ableton");
                assert_eq!(parsed.tracks[0].items[0].source_path, source_path);
        }

        #[test]
        fn ableton_finds_stem_by_name_when_every_stored_path_is_stale() {
                // Only the author's Windows path, read on any machine: the stem
                // is found by name inside the project folder.
                let temp = tempfile::tempdir().expect("tempdir");
                let source_path = temp.path().join("Stems").join("guide.WAV");
                fs::create_dir_all(source_path.parent().expect("dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");
                let project_path = temp.path().join("song.als");
                fs::write(
                        &project_path,
                        ableton_set_with_file_ref(
                                r#"<FileRef>
                                <Path Value="C:\Users\autor\Desktop\Proyecto\Samples\Guide.wav"/>
                            </FileRef>"#,
                        ),
                )
                .expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse ableton");
                assert_eq!(parsed.tracks[0].items[0].source_path, source_path);
        }
        #[test]
        fn ableton_unwarped_clip_keeps_its_whole_audio_length() {
                // A MultiTracks pack saved by Live 8: the clips are unwarped and
                // their end (CurrentEnd, LoopEnd) is in SECONDS of the file. Read
                // as beats at 70 bpm, every stem stopped at 276.6 s of 322.7 s.
                let temp = tempfile::tempdir().expect("tempdir");
                let source_path = temp.path().join("MultiTracks").join("Bass.wav");
                fs::create_dir_all(source_path.parent().expect("dir")).expect("mkdir");
                fs::write(&source_path, b"wav").expect("write wav");
                let project_path = temp.path().join("MultiTrack.als");
                let als = r#"<?xml version="1.0" encoding="utf-8"?>
<Ableton MajorVersion="4" MinorVersion="8.1_226" Creator="Ableton Live 8.4.2">
  <LiveSet>
    <Tracks>
      <AudioTrack>
        <Name><EffectiveName Value="Bass" /></Name>
        <DeviceChain><MainSequencer><Sample><ArrangerAutomation><Events>
          <AudioClip Time="0">
            <CurrentStart Value="0" />
            <CurrentEnd Value="322.67859400" />
            <Loop>
              <LoopStart Value="0" />
              <LoopEnd Value="322.67859400" />
              <StartRelative Value="0" />
              <LoopOn Value="false" />
              <OutMarker Value="322.67859400" />
            </Loop>
            <SampleRef><FileRef>
              <HasRelativePath Value="true" />
              <RelativePath><RelativePathElement Dir="MultiTracks" /></RelativePath>
              <Name Value="Bass.wav" />
            </FileRef></SampleRef>
            <IsWarped Value="false" />
          </AudioClip>
        </Events></ArrangerAutomation></Sample></MainSequencer></DeviceChain>
      </AudioTrack>
    </Tracks>
    <MasterTrack><DeviceChain><Mixer>
      <Tempo><ArrangerAutomation><Events>
        <FloatEvent Time="-63072000" Value="70" />
      </Events></ArrangerAutomation></Tempo>
    </Mixer></DeviceChain></MasterTrack>
  </LiveSet>
</Ableton>"#;
                fs::write(&project_path, als).expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse ableton");
                let clip = &parsed.tracks[0].items[0];
                assert!((clip.length_seconds - 322.678594).abs() < 0.001, "got {}", clip.length_seconds);
                assert!(clip.source_start_seconds.abs() < 0.0001);
                assert!(parsed.regions[0].end_seconds >= clip.length_seconds - 0.0001);
        }

        #[test]
        fn ableton_warped_clip_markers_stay_in_beats() {
                // Same clip, warped: its markers are beats and follow the tempo.
                let temp = tempfile::tempdir().expect("tempdir");
                let source_path = temp.path().join("Bass.wav");
                fs::write(&source_path, b"wav").expect("write wav");
                let project_path = temp.path().join("song.als");
                let als = r#"<?xml version="1.0" encoding="utf-8"?>
<Ableton><LiveSet>
  <MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="120"/></Tempo></Mixer></DeviceChain></MasterTrack>
  <Tracks><AudioTrack><DeviceChain><MainSequencer><Sample><ArrangerAutomation><Events>
    <AudioClip Time="0">
      <CurrentStart Value="0" /><CurrentEnd Value="8" />
      <Loop><LoopStart Value="0" /><LoopEnd Value="8" /><StartRelative Value="0" /><LoopOn Value="false" /></Loop>
      <SampleRef><FileRef><Name Value="Bass.wav" /></FileRef></SampleRef>
      <IsWarped Value="true" />
    </AudioClip>
  </Events></ArrangerAutomation></Sample></MainSequencer></DeviceChain></AudioTrack></Tracks>
</LiveSet></Ableton>"#;
                fs::write(&project_path, als).expect("write als");

                let parsed = parse_ableton_project(&project_path).expect("parse ableton");
                // 8 beats at 120 bpm.
                assert!((parsed.tracks[0].items[0].length_seconds - 4.0).abs() < 0.001);
        }

    // ---- MIDI import -------------------------------------------------------

    fn note_events(item: &super::ExternalMidiItem) -> Vec<(f64, u8, f64)> {
        item.events
            .iter()
            .filter_map(|event| match event.kind {
                libretracks_core::MidiEventKind::Note {
                    note,
                    duration_seconds,
                    ..
                } => Some((event.at_seconds, note, duration_seconds)),
                _ => None,
            })
            .collect()
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn ableton_imports_arrangement_midi_tracks_with_routing() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_path = temp.path().join("midi.als");
        // 120 bpm: 1 beat = 0.5 s. Clip at beat 8, 4 beats long, loop of 2
        // beats -> the two notes play twice. A Session View clip (ClipSlot) and
        // a disabled note must be ignored.
        let als = r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton>
  <LiveSet>
    <Tracks>
      <MidiTrack Id="1">
        <Name><EffectiveName Value="Letras" /><UserName Value="Letras" /></Name>
        <DeviceChain>
          <MidiOutputRouting>
            <Target Value="MidiOut/External/abc/Ch3" />
            <UpperDisplayString Value="loopMIDI Port" />
            <LowerDisplayString Value="Ch. 3" />
          </MidiOutputRouting>
          <MainSequencer>
            <ClipSlotList>
              <ClipSlot><ClipSlot><Value>
                <MidiClip Id="9" Time="0">
                  <CurrentStart Value="0" /><CurrentEnd Value="4" />
                  <Notes><KeyTracks><KeyTrack Id="0"><Notes>
                    <MidiNoteEvent Time="0" Duration="1" Velocity="100" IsEnabled="true" />
                  </Notes><MidiKey Value="70" /></KeyTrack></KeyTracks></Notes>
                </MidiClip>
              </Value></ClipSlot></ClipSlot>
            </ClipSlotList>
            <ClipTimeable><ArrangerAutomation><Events>
              <MidiClip Id="0" Time="8">
                <CurrentStart Value="8" />
                <CurrentEnd Value="12" />
                <Loop>
                  <LoopStart Value="0" />
                  <LoopEnd Value="2" />
                  <StartRelative Value="0" />
                  <LoopOn Value="true" />
                </Loop>
                <Name Value="Verso" />
                <ProgramChange Value="5" />
                <Notes><KeyTracks>
                  <KeyTrack Id="0">
                    <Notes>
                      <MidiNoteEvent Time="0" Duration="0.5" Velocity="100" IsEnabled="true" />
                      <MidiNoteEvent Time="1.5" Duration="1" Velocity="90" IsEnabled="true" />
                      <MidiNoteEvent Time="1" Duration="0.5" Velocity="90" IsEnabled="false" />
                    </Notes>
                    <MidiKey Value="60" />
                  </KeyTrack>
                </KeyTracks></Notes>
              </MidiClip>
            </Events></ArrangerAutomation></ClipTimeable>
          </MainSequencer>
        </DeviceChain>
      </MidiTrack>
    </Tracks>
    <MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="120" /></Tempo></Mixer></DeviceChain></MasterTrack>
  </LiveSet>
</Ableton>"#;
        fs::write(&project_path, als).expect("write als");

        let parsed = parse_ableton_project(&project_path).expect("parse ableton");
        assert_eq!(parsed.tracks.len(), 1);
        let track = &parsed.tracks[0];
        assert_eq!(track.name, "Letras");
        assert!(track.items.is_empty());
        assert_eq!(track.midi_port.as_deref(), Some("loopMIDI Port"));
        assert_eq!(track.midi_channel, Some(3));
        assert_eq!(track.midi_items.len(), 1);
        let item = &track.midi_items[0];
        assert_eq!(item.name, "Verso");
        assert!(approx(item.position_seconds, 4.0));
        assert!(approx(item.length_seconds, 2.0));
        assert!(matches!(
            item.events[0].kind,
            libretracks_core::MidiEventKind::ProgramChange { program: 5 }
        ));
        let notes = note_events(item);
        assert_eq!(notes.len(), 4, "{notes:?}");
        assert!(approx(notes[0].0, 0.0) && notes[0].1 == 60 && approx(notes[0].2, 0.25));
        // Second note: 1.5 beats in, cut at the loop end (0.5 beat).
        assert!(approx(notes[1].0, 0.75) && approx(notes[1].2, 0.25));
        assert!(approx(notes[2].0, 1.0));
        assert!(approx(notes[3].0, 1.75));
        assert!(approx(parsed.duration_seconds, 6.0));
    }

    #[test]
    fn ableton_midi_track_without_external_output_has_no_port() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_path = temp.path().join("midi-none.als");
        let als = r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton><LiveSet><Tracks>
  <MidiTrack Id="1">
    <Name><EffectiveName Value="Luces" /></Name>
    <DeviceChain>
      <MidiOutputRouting>
        <Target Value="MidiOut/None" />
        <UpperDisplayString Value="No Output" />
        <LowerDisplayString Value="" />
      </MidiOutputRouting>
      <MainSequencer><ClipTimeable><ArrangerAutomation><Events>
        <MidiClip Id="0" Time="0">
          <CurrentStart Value="0" /><CurrentEnd Value="4" />
          <Loop><LoopStart Value="0" /><LoopEnd Value="4" /><LoopOn Value="false" /></Loop>
          <Notes><KeyTracks><KeyTrack Id="0"><MidiKey Value="36" /><Notes>
            <MidiNoteEvent Time="2" Duration="4" Velocity="127" />
            <MidiNoteEvent Time="5" Duration="1" Velocity="127" />
          </Notes></KeyTrack></KeyTracks></Notes>
        </MidiClip>
      </Events></ArrangerAutomation></ClipTimeable></MainSequencer>
    </DeviceChain>
  </MidiTrack>
</Tracks>
<MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="60" /></Tempo></Mixer></DeviceChain></MasterTrack>
</LiveSet></Ableton>"#;
        fs::write(&project_path, als).expect("write als");

        let parsed = parse_ableton_project(&project_path).expect("parse ableton");
        let track = &parsed.tracks[0];
        assert_eq!(track.midi_port, None);
        assert_eq!(track.midi_channel, None);
        // MidiKey before the notes works too; the note past the end marker is
        // dropped and the held one is cut at the clip end.
        let notes = note_events(&track.midi_items[0]);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(approx(notes[0].0, 2.0) && notes[0].1 == 36 && approx(notes[0].2, 2.0));
    }

    #[test]
    fn reaper_imports_inline_midi_items() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_path = temp.path().join("midi.rpp");
        // 120 bpm, 960 ticks per quarter = 0.5 s per 960 ticks. The FX chain
        // before the item used to end the track early and drop the item.
        let rpp = r#"
<REAPER_PROJECT 0.1 "7.0/x64" 1710000000
  TEMPO 120 4 4
  <TRACK
    NAME "Luces"
    <FXCHAIN
      SHOW 0
      <VST "VST: ReaSynth" reasynth.dll 0
        abc
      >
    >
    <ITEM
      POSITION 2.0
      LENGTH 2.0
      NAME "Escena"
      <SOURCE MIDI
        HASDATA 1 960 QN
        E 0 c2 07 00
        E 0 92 3c 64
        <X 480 0
          /w8BAA==
        >
        E 0 b2 07 7f
        e 480 82 3c 00
        Em 480 92 3e 64
        E 0 91 40 50
        E 960 81 40 00
        E 0 b0 7b 00
      >
    >
  >
>
"#;
        fs::write(&project_path, rpp).expect("write rpp");

        let parsed = parse_reaper_project(&project_path).expect("parse reaper");
        assert_eq!(parsed.tracks.len(), 1);
        let track = &parsed.tracks[0];
        // The take name no longer renames the track.
        assert_eq!(track.name, "Luces");
        assert_eq!(track.midi_items.len(), 1);
        let item = &track.midi_items[0];
        assert_eq!(item.name, "Escena");
        assert!(approx(item.position_seconds, 2.0));
        assert_eq!(track.midi_channel, Some(3));

        use libretracks_core::MidiEventKind as K;
        let kinds = item
            .events
            .iter()
            .map(|event| (event.at_seconds, event.channel, event.kind.clone()))
            .collect::<Vec<_>>();
        assert!(kinds.iter().any(|(at, ch, kind)| approx(*at, 0.0)
            && *ch == Some(3)
            && matches!(kind, K::ProgramChange { program: 7 })));
        // CC after the 480-tick sysex block: 0.25 s.
        assert!(kinds.iter().any(|(at, _, kind)| approx(*at, 0.25)
            && matches!(kind, K::ControlChange { controller: 7, value: 127 })));
        let notes = note_events(item);
        // The muted note is skipped but its delta still counts.
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(approx(notes[0].0, 0.0) && notes[0].1 == 60 && approx(notes[0].2, 0.5));
        assert!(approx(notes[1].0, 0.75) && notes[1].1 == 64 && approx(notes[1].2, 0.5));
        assert_eq!(
            item.events
                .iter()
                .find(|event| matches!(event.kind, K::Note { note: 64, .. }))
                .and_then(|event| event.channel),
            Some(2)
        );
    }

    #[test]
    fn reaper_looped_midi_item_repeats_its_source() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_path = temp.path().join("loop.rpp");
        let rpp = r#"
<REAPER_PROJECT 0.1 "7.0/x64" 1710000000
  TEMPO 60 4 4
  <TRACK
    NAME "Clic"
    <ITEM
      POSITION 0
      LENGTH 3.5
      LOOPSRC 1
      <SOURCE MIDI
        HASDATA 1 960 QN
        E 0 90 3c 64
        E 480 80 3c 00
        E 480 b0 7b 00
      >
    >
  >
>
"#;
        fs::write(&project_path, rpp).expect("write rpp");

        let parsed = parse_reaper_project(&project_path).expect("parse reaper");
        let notes = note_events(&parsed.tracks[0].midi_items[0]);
        let starts = notes.iter().map(|note| note.0).collect::<Vec<_>>();
        assert_eq!(starts.len(), 4, "{starts:?}");
        for (start, expected) in starts.iter().zip([0.0, 1.0, 2.0, 3.0]) {
            assert!(approx(*start, expected), "{starts:?}");
        }
        // The last repeat is cut at the item end.
        assert!(approx(notes[3].2, 0.5));
    }
}
