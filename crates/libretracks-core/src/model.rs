use serde::{Deserialize, Serialize};

fn default_song_bpm() -> f64 {
    120.0
}

fn default_song_time_signature() -> String {
    "4/4".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub songs: Vec<Song>,
    pub setlists: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub key: Option<String>,
    #[serde(default = "default_song_bpm")]
    pub bpm: f64,
    #[serde(default = "default_song_time_signature")]
    pub time_signature: String,
    pub duration_seconds: f64,
    #[serde(default)]
    pub tempo_markers: Vec<TempoMarker>,
    #[serde(default)]
    pub time_signature_markers: Vec<TimeSignatureMarker>,
    #[serde(default)]
    pub regions: Vec<SongRegion>,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    pub section_markers: Vec<Marker>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TempoMarker {
    pub id: String,
    pub start_seconds: f64,
    pub bpm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongRegion {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Audio,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    pub parent_track_id: Option<String>,
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
    #[serde(default = "default_audio_to", alias = "outputBusId")]
    pub audio_to: String,
}

pub fn default_audio_to() -> String {
    "master".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub track_id: String,
    pub file_path: String,
    pub timeline_start_seconds: f64,
    pub source_start_seconds: f64,
    pub duration_seconds: f64,
    pub gain: f64,
    pub fade_in_seconds: Option<f64>,
    pub fade_out_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub digit: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TempoSource {
    #[default]
    Manual,
    AutoImport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TempoMetadata {
    #[serde(default)]
    pub source: TempoSource,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub reference_file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimeSignatureMarker {
    pub id: String,
    pub start_seconds: f64,
    pub signature: String,
}

pub fn parse_audio_output_route(audio_to: &str, available_channels: usize) -> Vec<usize> {
    let channel_count = available_channels.max(1);
    let normalized = audio_to.trim().to_ascii_lowercase();

    match normalized.as_str() {
        "" | "master" | "main" => return stereo_pair(0, channel_count),
        "monitor" => {
            return if channel_count >= 4 {
                stereo_pair(2, channel_count)
            } else {
                stereo_pair(0, channel_count)
            };
        }
        _ => {}
    }

    if let Some(explicit) = parse_external_output_channels(&normalized, channel_count) {
        return explicit;
    }

    stereo_pair(0, channel_count)
}

fn parse_external_output_channels(
    normalized_audio_to: &str,
    available_channels: usize,
) -> Option<Vec<usize>> {
    let mut value = normalized_audio_to
        .trim_start_matches("ext:")
        .trim_start_matches("hardware:")
        .trim()
        .to_string();
    if let Some(stripped) = value.strip_prefix("out ") {
        value = stripped.trim().to_string();
    }
    if let Some(stripped) = value.strip_prefix("out_") {
        value = stripped.trim().to_string();
    }
    if let Some(stripped) = value.strip_prefix("out") {
        value = stripped.trim().to_string();
    }

    if let Some((start, end)) = value.split_once('-') {
        let start = start.trim().parse::<usize>().ok()?;
        let end = end.trim().parse::<usize>().ok()?;
        if end < start || (!normalized_audio_to.starts_with("ext:") && (start == 0 || end == 0)) {
            return None;
        }

        let mut channels = Vec::new();
        for channel in start..=end {
            let zero_based = if normalized_audio_to.starts_with("ext:") {
                channel
            } else {
                channel - 1
            };
            if zero_based < available_channels {
                channels.push(zero_based);
            }
        }
        return (!channels.is_empty()).then_some(channels);
    }

    let channel = value.parse::<usize>().ok()?;
    if channel == 0 && !normalized_audio_to.starts_with("ext:") {
        return None;
    }
    let zero_based = if normalized_audio_to.starts_with("ext:") {
        channel
    } else {
        channel - 1
    };
    (zero_based < available_channels).then_some(vec![zero_based])
}

fn stereo_pair(start_channel: usize, available_channels: usize) -> Vec<usize> {
    let first = start_channel.min(available_channels.saturating_sub(1));
    let second = (first + 1).min(available_channels.saturating_sub(1));
    if first == second {
        vec![first]
    } else {
        vec![first, second]
    }
}

impl Song {
    pub fn sorted_markers(&self) -> Vec<&Marker> {
        let mut markers = self.section_markers.iter().collect::<Vec<_>>();
        markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        markers
    }

    pub fn marker_by_id(&self, marker_id: &str) -> Option<&Marker> {
        self.section_markers
            .iter()
            .find(|marker| marker.id == marker_id)
    }

    pub fn marker_by_digit(&self, digit: u8) -> Option<&Marker> {
        self.section_markers
            .iter()
            .find(|marker| marker.digit == Some(digit))
    }

    pub fn marker_at(&self, position_seconds: f64) -> Option<Marker> {
        if position_seconds < 0.0 {
            return None;
        }

        self.sorted_markers()
            .into_iter()
            .rev()
            .find(|marker| marker.start_seconds <= position_seconds)
            .cloned()
    }

    pub fn next_marker_after(&self, position_seconds: f64) -> Option<Marker> {
        self.sorted_markers()
            .into_iter()
            .find(|marker| marker.start_seconds > position_seconds)
            .cloned()
    }

    pub fn next_marker_name(&self) -> String {
        format!("Marker {}", self.section_markers.len())
    }
}
