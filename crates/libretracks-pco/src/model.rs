//! What the client hands to the app, serialized camelCase for the frontend
//! (TS `PcoArrangement`, `PcoPlanItem` in `@libretracks/shared/charts/importedChart`).
//! Raw attributes, read tolerantly: a missing field is empty, an unknown one
//! is ignored.

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcoAccount {
    /// The person's full name.
    pub name: String,
    pub organization: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    /// The page this is, from 0.
    pub page: u32,
    pub has_more: bool,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcoSong {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub ccli_number: Option<String>,
    pub last_scheduled_at: Option<String>,
}

/// One item of `sequence_full`. Planning Center sends the number as text
/// ("1"), and "1" even when the label had none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PcoSequenceEntry {
    pub label: String,
    #[serde(deserialize_with = "text_or_number")]
    pub number: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcoArrangement {
    pub id: String,
    pub song_id: String,
    pub name: String,
    pub chord_chart: Option<String>,
    pub chord_chart_key: Option<String>,
    pub lyrics: Option<String>,
    pub sequence: Vec<String>,
    pub sequence_full: Vec<PcoSequenceEntry>,
    pub bpm: Option<f64>,
    pub meter: Option<String>,
    pub updated_at: Option<String>,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcoServiceType {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcoPlan {
    pub id: String,
    pub title: Option<String>,
    pub dates: Option<String>,
    pub sort_date: Option<String>,
    pub series_title: Option<String>,
}

/// A song item of a plan (other items, headers and media, are left out).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcoPlanItem {
    pub id: String,
    pub title: Option<String>,
    pub sequence: u32,
    pub song_id: Option<String>,
    pub arrangement_id: Option<String>,
    /// The service's key ("Tono E" → "E"); `None` without one.
    pub key_name: Option<String>,
    pub custom_arrangement_sequence: Vec<String>,
    pub custom_arrangement_sequence_full: Vec<PcoSequenceEntry>,
}

/// What LibreTracks writes to an arrangement: the chart as Planning Center
/// shows it, its key and the song's sequence. `name` only for a new one.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangementWrite {
    #[serde(default)]
    pub name: Option<String>,
    pub chord_chart: String,
    pub chord_chart_key: String,
    /// `None`: the arrangement's sequence is not touched (the repeats went
    /// in the sheet as "// … //").
    #[serde(default)]
    pub sequence: Option<Vec<String>>,
    /// The song's duration in whole seconds (Planning Center's `length`).
    /// `None` or 0: the arrangement's length is not touched.
    #[serde(default)]
    pub length: Option<u32>,
    /// The tempo the song starts at. `None`: not touched.
    #[serde(default)]
    pub bpm: Option<f64>,
    /// The time signature the song starts in ("4/4", "6/8"). `None`: not touched.
    #[serde(default)]
    pub meter: Option<String>,
}

impl ArrangementWrite {
    /// The JSON:API body.
    pub fn body(&self) -> serde_json::Value {
        let mut attributes = serde_json::json!({
            "chord_chart": self.chord_chart,
            "chord_chart_key": self.chord_chart_key,
        });
        if let Some(sequence) = &self.sequence {
            attributes["sequence"] = serde_json::json!(sequence);
        }
        if let Some(length) = self.length.filter(|length| *length > 0) {
            attributes["length"] = serde_json::json!(length);
        }
        if let Some(bpm) = self.bpm.filter(|bpm| bpm.is_finite() && *bpm > 0.0) {
            attributes["bpm"] = serde_json::json!(bpm);
        }
        if let Some(meter) = self.meter.as_deref().map(str::trim).filter(|meter| !meter.is_empty()) {
            attributes["meter"] = serde_json::Value::String(meter.to_string());
        }
        if let Some(name) = self.name.as_deref().filter(|name| !name.trim().is_empty()) {
            attributes["name"] = serde_json::Value::String(name.trim().to_string());
        }
        serde_json::json!({ "data": { "type": "Arrangement", "attributes": attributes } })
    }
}

// --- JSON:API, as read ---------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct Document<T> {
    pub data: T,
    #[serde(default)]
    pub links: Links,
    #[serde(default)]
    pub meta: Meta,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct Links {
    #[serde(default)]
    pub next: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct Meta {
    #[serde(default)]
    pub total_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "A: Deserialize<'de> + Default"))]
pub(crate) struct Resource<A> {
    pub id: String,
    #[serde(default = "default_attributes")]
    pub attributes: A,
    #[serde(default)]
    pub relationships: serde_json::Value,
}

fn default_attributes<A: Default>() -> A {
    A::default()
}

impl<A> Resource<A> {
    /// `relationships.<name>.data.id`.
    pub fn related_id(&self, name: &str) -> Option<String> {
        self.relationships[name]["data"]["id"]
            .as_str()
            .map(str::to_string)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct PersonAttributes {
    pub full_name: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct OrganizationAttributes {
    pub name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct SongAttributes {
    pub title: Option<String>,
    pub author: Option<String>,
    #[serde(deserialize_with = "text_or_number")]
    pub ccli_number: Option<String>,
    pub last_scheduled_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct ArrangementAttributes {
    pub name: Option<String>,
    pub chord_chart: Option<String>,
    pub chord_chart_key: Option<String>,
    pub lyrics: Option<String>,
    #[serde(deserialize_with = "null_as_default")]
    pub sequence: Vec<String>,
    #[serde(deserialize_with = "null_as_default")]
    pub sequence_full: Vec<PcoSequenceEntry>,
    pub bpm: Option<f64>,
    pub meter: Option<String>,
    pub updated_at: Option<String>,
    pub archived_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct KeyAttributes {
    pub starting_key: Option<String>,
}

/// The keys Planning Center accepts for a Key's `starting_key` (minor with a
/// trailing "m").
const PCO_KEYS: &[&str] = &[
    "Ab", "A", "A#", "Bb", "B", "C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#",
];

/// The key as Planning Center writes it ("F#", "Dm"), or `None` for one it
/// does not accept.
pub fn pco_key(key: &str) -> Option<String> {
    let key = key.trim();
    let root = key.strip_suffix('m').unwrap_or(key);
    let found = PCO_KEYS.iter().find(|candidate| candidate.eq_ignore_ascii_case(root))?;
    Some(if root.len() < key.len() { format!("{found}m") } else { (*found).to_string() })
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct NamedAttributes {
    pub name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct PlanAttributes {
    pub title: Option<String>,
    pub dates: Option<String>,
    pub sort_date: Option<String>,
    pub series_title: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct ItemAttributes {
    pub title: Option<String>,
    pub item_type: Option<String>,
    pub sequence: Option<u32>,
    pub key_name: Option<String>,
    #[serde(deserialize_with = "null_as_default")]
    pub custom_arrangement_sequence: Vec<String>,
    #[serde(deserialize_with = "null_as_default")]
    pub custom_arrangement_sequence_full: Vec<PcoSequenceEntry>,
}

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn text_or_number<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::String(text) if !text.trim().is_empty() => Some(text),
        serde_json::Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

impl From<Resource<ArrangementAttributes>> for PcoArrangement {
    fn from(resource: Resource<ArrangementAttributes>) -> Self {
        let song_id = resource.related_id("song").unwrap_or_default();
        let attributes = resource.attributes;
        PcoArrangement {
            id: resource.id,
            song_id,
            name: attributes.name.unwrap_or_default(),
            chord_chart: attributes.chord_chart,
            chord_chart_key: attributes.chord_chart_key,
            lyrics: attributes.lyrics,
            sequence: attributes.sequence,
            sequence_full: attributes.sequence_full,
            bpm: attributes.bpm,
            meter: attributes.meter,
            updated_at: attributes.updated_at,
            archived_at: attributes.archived_at,
        }
    }
}
