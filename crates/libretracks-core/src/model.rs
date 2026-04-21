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
    #[serde(default)]
    pub tempo_metadata: TempoMetadata,
    pub key: Option<String>,
    pub time_signature: String,
    pub duration_seconds: f64,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    pub section_markers: Vec<SectionMarker>,
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
pub struct SectionMarker {
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

#[derive(Debug, Clone, PartialEq)]
pub struct DerivedSection {
    pub marker_id: Option<String>,
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub digit: Option<u8>,
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

impl Song {
    pub fn sorted_section_markers(&self) -> Vec<&SectionMarker> {
        let mut markers = self.section_markers.iter().collect::<Vec<_>>();
        markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        markers
    }

    pub fn section_marker_by_id(&self, marker_id: &str) -> Option<&SectionMarker> {
        self.section_markers.iter().find(|marker| marker.id == marker_id)
    }

    pub fn section_marker_by_digit(&self, digit: u8) -> Option<&SectionMarker> {
        self.section_markers
            .iter()
            .find(|marker| marker.digit == Some(digit))
    }

    pub fn derived_sections(&self) -> Vec<DerivedSection> {
        let markers = self.sorted_section_markers();
        let mut sections = Vec::new();

        if let Some(first_marker) = markers.first() {
            if first_marker.start_seconds > 0.0 {
                sections.push(DerivedSection {
                    marker_id: None,
                    name: "Inicio".to_string(),
                    start_seconds: 0.0,
                    end_seconds: first_marker.start_seconds.min(self.duration_seconds),
                    digit: None,
                });
            }
        }

        for (index, marker) in markers.iter().enumerate() {
            let end_seconds = markers
                .get(index + 1)
                .map(|next_marker| next_marker.start_seconds)
                .unwrap_or(self.duration_seconds)
                .min(self.duration_seconds);

            if end_seconds <= marker.start_seconds {
                continue;
            }

            sections.push(DerivedSection {
                marker_id: Some(marker.id.clone()),
                name: marker.name.clone(),
                start_seconds: marker.start_seconds,
                end_seconds,
                digit: marker.digit,
            });
        }

        sections
    }

    pub fn derived_section_at(&self, position_seconds: f64) -> Option<DerivedSection> {
        self.derived_sections().into_iter().find(|section| {
            position_seconds >= section.start_seconds && position_seconds < section.end_seconds
        })
    }

    pub fn derived_section_for_marker(&self, marker_id: &str) -> Option<DerivedSection> {
        self.derived_sections()
            .into_iter()
            .find(|section| section.marker_id.as_deref() == Some(marker_id))
    }
}
