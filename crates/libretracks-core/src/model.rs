use serde::{Deserialize, Serialize};

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
    pub bpm: f64,
    pub key: Option<String>,
    pub time_signature: String,
    pub duration_seconds: f64,
    pub tracks: Vec<Track>,
    pub groups: Vec<TrackGroup>,
    pub clips: Vec<Clip>,
    pub sections: Vec<Section>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
    pub output_bus_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackGroup {
    pub id: String,
    pub name: String,
    pub volume: f64,
    pub muted: bool,
    pub output_bus_id: String,
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
pub struct Section {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputBus {
    Main,
    Monitor,
}

impl OutputBus {
    pub fn id(self) -> String {
        match self {
            Self::Main => "main".to_string(),
            Self::Monitor => "monitor".to_string(),
        }
    }
}
