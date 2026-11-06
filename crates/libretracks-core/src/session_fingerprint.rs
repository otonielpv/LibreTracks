//! A fingerprint of a session that is stable BETWEEN MACHINES, to prove a
//! redundancy backup has the same session and timing settings as its main
//! (docs/plans/redundancy/03-huella-de-sesion.md). A backup with another
//! session is worse than no backup: it gives false confidence.
//!
//! Not one hash but one digest per thing that can differ, so the UI can say
//! WHAT differs ("“Song X”: the audio is different").
//!
//! Canonical form, never the file's JSON as is:
//! - the in-memory model (after any v7→v8 migration), turned into a JSON
//!   value and written with sorted keys, floats rounded to 1e-6 (a µs on
//!   positions) and `-0` folded to `0`;
//! - view-only fields (colours, column widths, collapsed folders, row
//!   heights, cover, lyrics chart, track names…) are dropped: they do not
//!   change what sounds or when;
//! - audio files by NAME, case-folded (case-insensitive file systems, see
//!   the library dedup), never by absolute path or modification date, which
//!   differ between machines with identical files. Each file adds its size
//!   in bytes, which the caller supplies ([`AudioFileInfo`]): the content of
//!   multi-GB WAVs is NOT read, so a re-render of the same length and format
//!   (same size) under the same name is not detected. Duration is not used
//!   either: it is only known after decoding and would make the fingerprint
//!   depend on what each machine has cached.
//!
//! Pure: no disk, no clock. SHA-256 for the digests.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::automation::AutomationCue;
use crate::model::{Clip, Song, SongRegion, Track};

/// Bumped whenever the canonical form changes: two fingerprints of different
/// versions are never compared field by field.
pub const FINGERPRINT_VERSION: u32 = 1;

/// Hex SHA-256.
pub type Digest = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFingerprint {
    pub version: u32,
    /// Order of the songs (region ids by start).
    pub setlist: Digest,
    /// One per song (region), in setlist order.
    pub songs: Vec<SongFingerprint>,
    /// Every setting that changes WHEN something sounds, by name, already
    /// canonical, so a difference can be named.
    pub timing_settings: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongFingerprint {
    pub song_id: String,
    pub title: String,
    /// Markers, tempo and meter, ramps, key changes, arrangement and edited
    /// blocks, automation jumps, clips (start, length, offset, file, gain,
    /// fades, track), warp and transpose, track structure.
    pub timeline: Digest,
    /// Per file used: case-folded name + size in bytes.
    pub audio: Digest,
    /// Volume, pan, mute, solo, routes, mono, MIDI ports, the song master.
    /// Does not block arming (step 09 mirrors the live mix).
    pub mix: Digest,
}

/// What the caller knows about one audio file without decoding it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioFileInfo {
    pub size_bytes: u64,
}

/// The settings that move WHEN something sounds. Built by the app from its
/// own settings (see the desktop's `AppSettings`); everything else (theme,
/// language, UI sizes, audio device, meters…) stays out on purpose.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TimingSettings {
    pub global_jump_mode: String,
    pub global_jump_bars: u32,
    pub song_jump_trigger: String,
    pub song_jump_bars: u32,
    pub song_transition_mode: String,
    pub fade_out_stop_seconds: f64,
    pub vamp_mode: String,
    pub vamp_bars: u32,
    pub pause_at_song_end: bool,
    pub vamp_between_songs: bool,
    pub voice_guide_lead_bars: i32,
    pub voice_guide_count_in_enabled: bool,
}

impl TimingSettings {
    fn canonical(&self) -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        let mut put = |key: &str, value: String| {
            map.insert(key.to_string(), value);
        };
        put("globalJumpMode", self.global_jump_mode.clone());
        put("globalJumpBars", self.global_jump_bars.to_string());
        put("songJumpTrigger", self.song_jump_trigger.clone());
        put("songJumpBars", self.song_jump_bars.to_string());
        put("songTransitionMode", self.song_transition_mode.clone());
        put("fadeOutStopSeconds", round(self.fade_out_stop_seconds));
        put("vampMode", self.vamp_mode.clone());
        put("vampBars", self.vamp_bars.to_string());
        put("pauseAtSongEnd", self.pause_at_song_end.to_string());
        put("vampBetweenSongs", self.vamp_between_songs.to_string());
        put("voiceGuideLeadBars", self.voice_guide_lead_bars.to_string());
        put(
            "voiceGuideCountInEnabled",
            self.voice_guide_count_in_enabled.to_string(),
        );
        map
    }
}

/// Everything the fingerprint is computed from.
pub struct FingerprintInput<'a> {
    pub song: &'a Song,
    /// The session's automation cues (they jump: they change WHEN).
    pub automation_cues: &'a [AutomationCue],
    pub timing: &'a TimingSettings,
}

/// One difference, in words the UI can show as is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FingerprintDiff {
    /// The two sides were computed by different algorithm versions.
    AlgorithmVersion,
    SetlistOrder,
    /// In the reference (main), not in the other (backup).
    SongMissing { title: String },
    /// In the other (backup), not in the reference (main).
    SongExtra { title: String },
    TimelineDiffers { title: String },
    AudioDiffers { title: String },
    MixDiffers { title: String },
    TimingSettingsDiffer { which: String },
}

impl FingerprintDiff {
    /// Whether this difference keeps a backup from arming. Only the mix does
    /// not: step 09 mirrors it live.
    pub fn blocks_arming(&self) -> bool {
        !matches!(self, FingerprintDiff::MixDiffers { .. })
    }
}

const EPSILON_SECONDS: f64 = 1e-6;

/// Fields that never change what sounds or when. Dropped at every depth of
/// the canonical value.
const VIEW_ONLY_KEYS: &[&str] = &[
    "color",
    "compactColumnWidthRem",
    "coverImage",
    "chart",
    "collapsed",
    "heightOffset",
    "matchAliases",
    "autoCreated",
    "songRegionId",
];

/// Track fields that are the mix (go to `mix`, not to `timeline`).
const TRACK_MIX_KEYS: &[&str] = &[
    "volume",
    "pan",
    "muted",
    "solo",
    "audioTo",
    "outputBusId",
    "monoDownmix",
    "midiPort",
    "midiChannel",
    "midiEnabled",
];

pub fn fingerprint(
    input: &FingerprintInput<'_>,
    audio_info: impl Fn(&str) -> Option<AudioFileInfo>,
) -> SessionFingerprint {
    let song = input.song;
    let mut regions: Vec<&SongRegion> = song.regions.iter().collect();
    regions.sort_by(|a, b| {
        a.start_seconds
            .total_cmp(&b.start_seconds)
            .then_with(|| a.id.cmp(&b.id))
    });

    let setlist = digest_of(&Value::Array(
        regions.iter().map(|region| Value::from(region.id.clone())).collect(),
    ));
    let songs = regions
        .iter()
        .map(|region| song_fingerprint(song, region, input.automation_cues, &audio_info))
        .collect();

    SessionFingerprint {
        version: FINGERPRINT_VERSION,
        setlist,
        songs,
        timing_settings: input.timing.canonical(),
    }
}

fn song_fingerprint(
    song: &Song,
    region: &SongRegion,
    automation_cues: &[AutomationCue],
    audio_info: &impl Fn(&str) -> Option<AudioFileInfo>,
) -> SongFingerprint {
    let inside = |seconds: f64| {
        seconds >= region.start_seconds - EPSILON_SECONDS
            && seconds < region.end_seconds - EPSILON_SECONDS
    };
    let clips: Vec<&Clip> = song
        .clips
        .iter()
        .filter(|clip| inside(clip.timeline_start_seconds))
        .collect();
    let midi_clips: Vec<_> = song
        .midi_clips
        .iter()
        .filter(|clip| inside(clip.timeline_start_seconds))
        .collect();
    let video_clips: Vec<_> = song
        .video_clips
        .iter()
        .filter(|clip| inside(clip.timeline_start_seconds))
        .collect();
    let markers: Vec<_> = song
        .section_markers
        .iter()
        .filter(|marker| inside(marker.start_seconds))
        .collect();
    let tempo_markers: Vec<_> = song
        .tempo_markers
        .iter()
        .filter(|marker| inside(marker.start_seconds))
        .collect();
    let meter_markers: Vec<_> = song
        .time_signature_markers
        .iter()
        .filter(|marker| inside(marker.start_seconds))
        .collect();
    let cues: Vec<_> = automation_cues
        .iter()
        .filter(|cue| inside(cue.at_seconds))
        .collect();

    // What rules at the region's start when no marker AT the start says so:
    // the last marker before it, or the song's base.
    let starts_here = |seconds: f64| (seconds - region.start_seconds).abs() <= EPSILON_SECONDS;
    let own_tempo = tempo_markers.iter().any(|marker| starts_here(marker.start_seconds));
    let own_meter = meter_markers.iter().any(|marker| starts_here(marker.start_seconds));
    let base_bpm = song
        .tempo_markers
        .iter()
        .filter(|marker| marker.start_seconds < region.start_seconds - EPSILON_SECONDS)
        .max_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds))
        .map_or(song.bpm, |marker| marker.bpm);
    let base_meter = song
        .time_signature_markers
        .iter()
        .filter(|marker| marker.start_seconds < region.start_seconds - EPSILON_SECONDS)
        .max_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds))
        .map_or(song.time_signature.clone(), |marker| marker.signature.clone());

    // Tracks this song uses, with their folder parents (folding gain/mute).
    let mut track_ids: BTreeSet<&str> = clips
        .iter()
        .map(|clip| clip.track_id.as_str())
        .chain(midi_clips.iter().map(|clip| clip.track_id.as_str()))
        .chain(video_clips.iter().map(|clip| clip.track_id.as_str()))
        .collect();
    if let Some(structure) = &region.structure {
        track_ids.extend(structure.stored_clips().map(|clip| clip.track_id.as_str()));
    }
    let mut pending: Vec<&str> = track_ids.iter().copied().collect();
    while let Some(id) = pending.pop() {
        if let Some(parent) = find_track(song, id).and_then(|track| track.parent_track_id.as_deref())
        {
            if track_ids.insert(parent) {
                pending.push(parent);
            }
        }
    }
    let tracks: Vec<&Track> = song
        .tracks
        .iter()
        .filter(|track| track_ids.contains(track.id.as_str()))
        .collect();

    let mut region_value = to_value(region);
    if let Value::Object(map) = &mut region_value {
        // Title and master are not timeline: the title is shown separately
        // and the master is the mix. Where the song sits is the setlist:
        // only its length stays here.
        map.remove("name");
        map.remove("master");
        map.remove("startSeconds");
        map.remove("endSeconds");
        map.insert(
            "durationSeconds".into(),
            Value::from(region.end_seconds - region.start_seconds),
        );
    }
    // Positions relative to the song's start: moving or reordering a whole
    // song is a setlist difference, not a timeline one.
    let origin = region.start_seconds;
    let rel = |value: Value| relative_to(value, origin);

    let timeline = serde_json::json!({
        "region": region_value,
        "baseBpm": if own_tempo { Value::Null } else { Value::from(base_bpm) },
        "baseTimeSignature": if own_meter { Value::Null } else { Value::from(base_meter) },
        "clips": sorted_by_id(clips.iter().map(|clip| rel(canonical_clip(clip))).collect()),
        "midiClips": sorted_by_id(midi_clips.iter().map(|c| rel(to_value(c))).collect()),
        "videoClips": sorted_by_id(video_clips.iter().map(|c| rel(to_value(c))).collect()),
        "markers": sorted_by_id(markers.iter().map(|m| rel(to_value(m))).collect()),
        "tempoMarkers": sorted_by_id(tempo_markers.iter().map(|m| rel(to_value(m))).collect()),
        "timeSignatureMarkers": sorted_by_id(meter_markers.iter().map(|m| rel(to_value(m))).collect()),
        "automationCues": sorted_by_id(cues.iter().map(|c| rel(to_value(c))).collect()),
        "tracks": tracks.iter().map(|track| track_part(track, false)).collect::<Vec<_>>(),
    });

    let mut files: BTreeSet<String> = clips.iter().map(|clip| file_key(&clip.file_path)).collect();
    let mut raw_paths: BTreeMap<String, &str> = clips
        .iter()
        .map(|clip| (file_key(&clip.file_path), clip.file_path.as_str()))
        .collect();
    if let Some(structure) = &region.structure {
        for clip in structure.stored_clips() {
            files.insert(file_key(&clip.file_path));
            raw_paths
                .entry(file_key(&clip.file_path))
                .or_insert(clip.file_path.as_str());
        }
    }
    let audio = Value::Array(
        files
            .iter()
            .map(|name| {
                let size = raw_paths
                    .get(name)
                    .and_then(|path| audio_info(path))
                    .map(|info| Value::from(info.size_bytes))
                    .unwrap_or(Value::Null);
                serde_json::json!({ "name": name, "size": size })
            })
            .collect(),
    );

    let mix = serde_json::json!({
        "master": to_value(&region.master),
        "tracks": tracks.iter().map(|track| track_part(track, true)).collect::<Vec<_>>(),
    });

    SongFingerprint {
        song_id: region.id.clone(),
        title: region.name.clone(),
        timeline: digest_of(&timeline),
        audio: digest_of(&audio),
        mix: digest_of(&mix),
    }
}

fn find_track<'a>(song: &'a Song, id: &str) -> Option<&'a Track> {
    song.tracks.iter().find(|track| track.id == id)
}

/// The track's structural part (`mix = false`: id, kind, parent, transpose)
/// or its mix part (`mix = true`). Names are view-only.
fn track_part(track: &Track, mix: bool) -> Value {
    let Value::Object(map) = to_value(track) else {
        return Value::Null;
    };
    let mut kept = serde_json::Map::new();
    kept.insert("id".into(), Value::from(track.id.clone()));
    for (key, value) in map {
        if key == "id" || key == "name" {
            continue;
        }
        if TRACK_MIX_KEYS.contains(&key.as_str()) == mix {
            kept.insert(key, value);
        }
    }
    Value::Object(kept)
}

fn canonical_clip(clip: &Clip) -> Value {
    let mut value = to_value(clip);
    if let Value::Object(map) = &mut value {
        map.insert("filePath".into(), Value::from(file_key(&clip.file_path)));
    }
    value
}

/// A file's identity between machines: its name, case-folded, without any
/// directory (relative `audio/x.wav` and an absolute path to the same file
/// name on another machine are the same file).
pub fn file_key(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_lowercase()
}

/// Top-level timeline positions (`timelineStartSeconds`, `startSeconds`,
/// `atSeconds`) made relative to `origin`.
fn relative_to(mut value: Value, origin: f64) -> Value {
    if let Value::Object(map) = &mut value {
        for key in ["timelineStartSeconds", "startSeconds", "atSeconds"] {
            if let Some(seconds) = map.get(key).and_then(Value::as_f64) {
                map.insert(key.into(), Value::from(seconds - origin));
            }
        }
    }
    value
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn sorted_by_id(mut values: Vec<Value>) -> Value {
    values.sort_by(|a, b| {
        let key = |value: &Value| value.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        key(a).cmp(&key(b))
    });
    Value::Array(values)
}

fn round(value: f64) -> String {
    let rounded = (value / EPSILON_SECONDS).round() * EPSILON_SECONDS;
    let rounded = if rounded == 0.0 { 0.0 } else { rounded };
    format!("{rounded:.6}")
}

/// Sorted keys, rounded floats, view-only keys dropped.
fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                out.push_str(&int.to_string());
            } else if let Some(uint) = number.as_u64() {
                out.push_str(&uint.to_string());
            } else {
                out.push_str(&round(number.as_f64().unwrap_or(0.0)));
            }
        }
        Value::String(text) => {
            out.push_str(&serde_json::to_string(text).unwrap_or_default());
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map
                .keys()
                .filter(|key| !VIEW_ONLY_KEYS.contains(&key.as_str()))
                .collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                write_canonical(&map[key], out);
            }
            out.push('}');
        }
    }
}

fn digest_of(value: &Value) -> Digest {
    let mut text = String::new();
    write_canonical(value, &mut text);
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Every difference between `reference` (the main) and `other` (the
/// backup). Empty = same session and timing settings.
pub fn compare(reference: &SessionFingerprint, other: &SessionFingerprint) -> Vec<FingerprintDiff> {
    if reference.version != other.version {
        return vec![FingerprintDiff::AlgorithmVersion];
    }
    let mut diffs = Vec::new();

    let ids = |fingerprint: &SessionFingerprint| -> BTreeSet<String> {
        fingerprint
            .songs
            .iter()
            .map(|song| song.song_id.clone())
            .collect()
    };
    if reference.setlist != other.setlist && ids(reference) == ids(other) {
        diffs.push(FingerprintDiff::SetlistOrder);
    }

    for song in &reference.songs {
        match other.songs.iter().find(|candidate| candidate.song_id == song.song_id) {
            None => diffs.push(FingerprintDiff::SongMissing {
                title: song.title.clone(),
            }),
            Some(theirs) => {
                if song.timeline != theirs.timeline {
                    diffs.push(FingerprintDiff::TimelineDiffers {
                        title: song.title.clone(),
                    });
                }
                if song.audio != theirs.audio {
                    diffs.push(FingerprintDiff::AudioDiffers {
                        title: song.title.clone(),
                    });
                }
                if song.mix != theirs.mix {
                    diffs.push(FingerprintDiff::MixDiffers {
                        title: song.title.clone(),
                    });
                }
            }
        }
    }
    for song in &other.songs {
        if !reference
            .songs
            .iter()
            .any(|candidate| candidate.song_id == song.song_id)
        {
            diffs.push(FingerprintDiff::SongExtra {
                title: song.title.clone(),
            });
        }
    }

    let keys: BTreeSet<&String> = reference
        .timing_settings
        .keys()
        .chain(other.timing_settings.keys())
        .collect();
    for key in keys {
        if reference.timing_settings.get(key) != other.timing_settings.get(key) {
            diffs.push(FingerprintDiff::TimingSettingsDiffer { which: key.clone() });
        }
    }
    diffs
}

#[cfg(test)]
#[path = "session_fingerprint_tests.rs"]
mod tests;
