//! MIDI control surfaces: what a binding is and the pure decisions behind it.
//!
//! Plan `docs/plans/midi-controllers`, paso 01. The desktop crate owns the
//! ports and the side effects; everything that can be decided from numbers
//! alone lives here so it can be tested (the desktop crate does not link its
//! tests):
//!
//! - [`MidiBinding`]: the message a control sends (type, channel, number) and
//!   how it behaves (absolute, relative, toggle, momentary; range, invert,
//!   soft takeover). Bindings stored before this plan were just
//!   `{status, data1, isCc}`; they still deserialize, every new field has a
//!   default, and [`MidiBinding::migrated`] folds the old quirks.
//! - [`MidiTarget`]: the typed form of the string keys (`action:play`,
//!   `track:<id>:volume`, `strip:3:mute`…). Keys stay strings on disk.
//! - [`MidiBindingIndex`]: message → targets, rebuilt when the mappings change,
//!   so a message is one hash lookup and one control can drive several targets.
//! - The value math: [`MidiBinding::scale`], [`decode_relative`],
//!   [`SoftTakeover`], [`ButtonState`] and the fader taper [`fader`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The kind of channel message a control sends. Note off folds into
/// [`MidiMessageKind::Note`]: a button bound from its press must also see its
/// release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MidiMessageKind {
    ControlChange,
    Note,
    PitchBend,
    ProgramChange,
    Other,
}

impl MidiMessageKind {
    pub fn from_status(status: u8) -> Self {
        match status & 0xF0 {
            0xB0 => Self::ControlChange,
            0x80 | 0x90 => Self::Note,
            0xE0 => Self::PitchBend,
            0xC0 => Self::ProgramChange,
            _ => Self::Other,
        }
    }

    /// Pitch bend carries its value in both data bytes and program change
    /// has no value at all: neither identifies the control by `data1`.
    fn number_identifies_control(self) -> bool {
        matches!(self, Self::ControlChange | Self::Note | Self::Other)
    }
}

/// What a message is matched on: kind, channel and control number. Note on
/// and note off of the same key, and every value of a pitch bend, share a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MidiControlKey {
    pub kind: MidiMessageKind,
    /// 0-15. For [`MidiMessageKind::Other`] it holds the whole status byte.
    pub channel: u8,
    pub number: u8,
}

impl MidiControlKey {
    pub fn from_message(status: u8, data1: u8) -> Self {
        let kind = MidiMessageKind::from_status(status);
        let channel = if kind == MidiMessageKind::Other {
            status
        } else {
            status & 0x0F
        };
        let number = if kind.number_identifies_control() {
            data1
        } else {
            0
        };
        Self {
            kind,
            channel,
            number,
        }
    }
}

/// How a control's value turns into a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlMode {
    /// The value is a position (fader, pot). Pitch bend is 14-bit.
    Absolute,
    /// Encoder, two's complement: 1..63 up, 127..65 down (65 = -63).
    RelativeTwosComplement,
    /// Encoder, binary offset: 64 is still, 65.. up, ..63 down.
    RelativeBinaryOffset,
    /// Encoder, sign + magnitude: 1..63 up, 65..127 down (65 = -1).
    RelativeSignMagnitude,
    /// Button: each press flips the target.
    Toggle,
    /// Button: on while held, off on release.
    Momentary,
    /// Button: fire the action once on press.
    Trigger,
}

impl ControlMode {
    pub fn is_relative(self) -> bool {
        matches!(
            self,
            Self::RelativeTwosComplement | Self::RelativeBinaryOffset | Self::RelativeSignMagnitude
        )
    }
}

/// A learned control. The first three fields are the pre-plan format and
/// still the whole of it in old settings files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MidiBinding {
    pub status: u8,
    pub data1: u8,
    /// Kept for old readers; [`MidiBinding::kind`] is what decides.
    pub is_cc: bool,
    /// `None` = the default for the target ([`MidiBinding::effective_mode`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ControlMode>,
    /// Lower end of the target travel this control covers, 0..1.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub min: f64,
    /// Upper end, 0..1. `min > max` is allowed and inverts too.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub max: f64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub invert: bool,
    /// Soft takeover for absolute controls. `None` = on (D6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub takeover: Option<bool>,
}

fn one() -> f64 {
    1.0
}
fn is_zero(value: &f64) -> bool {
    *value == 0.0
}
fn is_one(value: &f64) -> bool {
    *value == 1.0
}
fn is_false(value: &bool) -> bool {
    !*value
}

impl MidiBinding {
    /// A binding with the default behaviour, as the learn creates it.
    pub fn new(status: u8, data1: u8) -> Self {
        let kind = MidiMessageKind::from_status(status);
        Self {
            status,
            data1,
            is_cc: kind == MidiMessageKind::ControlChange,
            mode: None,
            min: 0.0,
            max: 1.0,
            invert: false,
            takeover: None,
        }
    }

    pub fn kind(&self) -> MidiMessageKind {
        MidiMessageKind::from_status(self.status)
    }

    pub fn control_key(&self) -> MidiControlKey {
        MidiControlKey::from_message(self.status, self.data1)
    }

    /// Folds what the old learn stored as-is into the canonical form:
    /// a button learned from its release (`0x8n`) is a note binding all the
    /// same, `isCc` follows the status, and a hand-edited range is clamped.
    pub fn migrated(mut self) -> Self {
        if self.status & 0xF0 == 0x80 {
            self.status = 0x90 | (self.status & 0x0F);
        }
        self.is_cc = self.kind() == MidiMessageKind::ControlChange;
        self.min = finite_or(self.min, 0.0).clamp(0.0, 1.0);
        self.max = finite_or(self.max, 1.0).clamp(0.0, 1.0);
        if let Some(mode) = self.mode {
            // A relative mode only makes sense on a CC.
            if mode.is_relative() && self.kind() != MidiMessageKind::ControlChange {
                self.mode = None;
            }
        }
        self
    }

    /// The mode when the user has not picked one: buttons (notes) toggle
    /// switch-like targets and trigger the rest; CC and pitch bend drive
    /// continuous targets as positions. A CC on a switch is a button too
    /// (nanoKONTROL2 S/M/R send CC 127/0).
    pub fn effective_mode(&self, target: &MidiTarget) -> ControlMode {
        if let Some(mode) = self.mode {
            return mode;
        }
        match target.value_kind() {
            TargetValueKind::Continuous => match self.kind() {
                MidiMessageKind::ControlChange | MidiMessageKind::PitchBend => {
                    ControlMode::Absolute
                }
                _ => ControlMode::Trigger,
            },
            TargetValueKind::Switch => ControlMode::Toggle,
            TargetValueKind::Trigger => ControlMode::Trigger,
        }
    }

    pub fn takeover_enabled(&self) -> bool {
        self.takeover.unwrap_or(true)
    }

    /// An absolute control's normalized value (0..1) mapped onto the
    /// binding's range: `min..max`, flipped by `invert`.
    pub fn scale(&self, normalized: f64) -> f64 {
        let value = normalized.clamp(0.0, 1.0);
        let value = if self.invert { 1.0 - value } else { value };
        (self.min + (self.max - self.min) * value).clamp(0.0, 1.0)
    }

    /// Where on the control the target value `position` (0..1) sits, the
    /// inverse of [`MidiBinding::scale`]. Used for takeover and for the
    /// feedback that moves motor faders. `None` when outside the range.
    pub fn unscale(&self, position: f64) -> Option<f64> {
        let span = self.max - self.min;
        if span.abs() < f64::EPSILON {
            return None;
        }
        let value = (position - self.min) / span;
        if !(-1e-9..=1.0 + 1e-9).contains(&value) {
            return None;
        }
        let value = value.clamp(0.0, 1.0);
        Some(if self.invert { 1.0 - value } else { value })
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

/// A message's value as 0..1: CC and note velocity over 127, pitch bend as
/// the 14-bit word. Program change has no value (1.0, it is a press).
pub fn normalized_value(status: u8, data1: u8, data2: u8) -> f64 {
    match MidiMessageKind::from_status(status) {
        MidiMessageKind::PitchBend => {
            let word = (u16::from(data2 & 0x7F) << 7) | u16::from(data1 & 0x7F);
            f64::from(word) / 16383.0
        }
        MidiMessageKind::ProgramChange => 1.0,
        MidiMessageKind::Note if status & 0xF0 == 0x80 => 0.0,
        _ => f64::from(data2 & 0x7F) / 127.0,
    }
}

/// An encoder message's step, in detents. Zero for "no movement".
pub fn decode_relative(data2: u8, mode: ControlMode) -> i32 {
    let value = i32::from(data2 & 0x7F);
    match mode {
        ControlMode::RelativeTwosComplement => {
            if value >= 64 {
                value - 128
            } else {
                value
            }
        }
        ControlMode::RelativeBinaryOffset => value - 64,
        ControlMode::RelativeSignMagnitude => {
            if value >= 64 {
                -(value - 64)
            } else {
                value
            }
        }
        _ => 0,
    }
}

/// How much of the target travel one encoder detent moves.
pub const RELATIVE_STEP: f64 = 1.0 / 128.0;

/// Soft takeover (D6): an absolute control without a motor does not move its
/// target until it reaches the target's current value, so switching songs or
/// banks does not make the volume jump on stage.
///
/// "Reaches" is "comes within [`SoftTakeover::THRESHOLD`]" or "crosses it
/// between two messages": a fast swipe skips values, so equality alone would
/// leave the fader stuck.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SoftTakeover {
    picked_up: bool,
    last_control: Option<f64>,
}

impl SoftTakeover {
    pub const THRESHOLD: f64 = 3.0 / 127.0;

    /// Feed a control position and the target's current position (both in
    /// control space, 0..1). Returns whether the target should follow.
    pub fn feed(&mut self, control: f64, current: f64) -> bool {
        if !self.picked_up {
            let near = (control - current).abs() <= Self::THRESHOLD;
            let crossed = self
                .last_control
                .is_some_and(|last| (last - current) * (control - current) <= 0.0);
            self.picked_up = near || crossed;
        }
        self.last_control = Some(control);
        self.picked_up
    }

    /// The target moved without this control (screen, another control, a
    /// new bank): the control has to catch it again.
    pub fn release(&mut self) {
        self.picked_up = false;
        self.last_control = None;
    }

    pub fn is_picked_up(&self) -> bool {
        self.picked_up
    }
}

/// What a button message means for a switch target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonEvent {
    /// Set the switch to this value.
    Set(bool),
    /// Fire once (trigger mode press).
    Fire,
    Ignore,
}

/// Button decisions. A press is a note on with velocity > 0 or a CC/pitch
/// bend above the middle; a release is the opposite. Hardware that toggles by
/// itself (sends 127 then 0 on alternate presses) works with
/// [`ControlMode::Momentary`]: it then mirrors the hardware state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ButtonState;

impl ButtonState {
    pub fn is_press(normalized: f64) -> bool {
        normalized >= 0.5
    }

    pub fn decide(mode: ControlMode, normalized: f64, current: bool) -> ButtonEvent {
        let pressed = Self::is_press(normalized);
        match mode {
            ControlMode::Toggle if pressed => ButtonEvent::Set(!current),
            ControlMode::Momentary => ButtonEvent::Set(pressed),
            ControlMode::Trigger if pressed => ButtonEvent::Fire,
            // An absolute control on a switch: past the middle is on.
            ControlMode::Absolute => ButtonEvent::Set(pressed),
            _ => ButtonEvent::Ignore,
        }
    }
}

/// One of a track's (or a strip's) mixer controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MixControl {
    Volume,
    Pan,
    Mute,
    Solo,
}

impl MixControl {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "volume" => Self::Volume,
            "pan" => Self::Pan,
            "mute" => Self::Mute,
            "solo" => Self::Solo,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Volume => "volume",
            Self::Pan => "pan",
            Self::Mute => "mute",
            Self::Solo => "solo",
        }
    }

    pub fn is_switch(self) -> bool {
        matches!(self, Self::Mute | Self::Solo)
    }
}

/// App-level mixer targets that are not a track.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MixerTarget {
    /// The master of the song under the playhead.
    SongMaster,
    Metronome,
    VoiceGuide,
    Pads,
}

impl MixerTarget {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "song_master" => Self::SongMaster,
            "metronome" => Self::Metronome,
            "voice_guide" => Self::VoiceGuide,
            "pads" => Self::Pads,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SongMaster => "song_master",
            Self::Metronome => "metronome",
            Self::VoiceGuide => "voice_guide",
            Self::Pads => "pads",
        }
    }
}

/// The typed form of a mapping key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum MidiTarget {
    /// `action:<name>` — fire once.
    Action(String),
    /// `param:<name>` — app setting driven by a value.
    Param(String),
    /// `track:<id>:<control>` — by id, survives renames and reorders (D7).
    Track { track_id: String, control: MixControl },
    /// `strip:<n>:<control>` — the n-th (1-based) track of the current bank.
    Strip { strip: u16, control: MixControl },
    /// `mixer:<target>:volume`.
    Mixer(MixerTarget),
    /// `bank:next` / `bank:prev`.
    Bank(i32),
}

/// What kind of value a target takes, which picks the default mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetValueKind {
    Continuous,
    Switch,
    Trigger,
}

impl MidiTarget {
    pub fn parse(key: &str) -> Option<Self> {
        if let Some(name) = key.strip_prefix("action:") {
            return (!name.is_empty()).then(|| Self::Action(name.to_string()));
        }
        if let Some(name) = key.strip_prefix("param:") {
            return (!name.is_empty()).then(|| Self::Param(name.to_string()));
        }
        if let Some(rest) = key.strip_prefix("track:") {
            // Ids never contain ':' in this app, but split from the right so
            // one that did would still parse.
            let (track_id, control) = rest.rsplit_once(':')?;
            if track_id.is_empty() {
                return None;
            }
            return Some(Self::Track {
                track_id: track_id.to_string(),
                control: MixControl::parse(control)?,
            });
        }
        if let Some(rest) = key.strip_prefix("strip:") {
            let (strip, control) = rest.split_once(':')?;
            let strip = strip.parse::<u16>().ok().filter(|strip| *strip > 0)?;
            return Some(Self::Strip {
                strip,
                control: MixControl::parse(control)?,
            });
        }
        if let Some(rest) = key.strip_prefix("mixer:") {
            let (target, control) = rest.split_once(':')?;
            if control != "volume" {
                return None;
            }
            return Some(Self::Mixer(MixerTarget::parse(target)?));
        }
        match key {
            "bank:next" => Some(Self::Bank(1)),
            "bank:prev" => Some(Self::Bank(-1)),
            _ => None,
        }
    }

    pub fn key(&self) -> String {
        match self {
            Self::Action(name) => format!("action:{name}"),
            Self::Param(name) => format!("param:{name}"),
            Self::Track { track_id, control } => format!("track:{track_id}:{}", control.as_str()),
            Self::Strip { strip, control } => format!("strip:{strip}:{}", control.as_str()),
            Self::Mixer(target) => format!("mixer:{}:volume", target.as_str()),
            Self::Bank(step) if *step < 0 => "bank:prev".to_string(),
            Self::Bank(_) => "bank:next".to_string(),
        }
    }

    pub fn value_kind(&self) -> TargetValueKind {
        match self {
            Self::Action(name) if name.starts_with("toggle_") => TargetValueKind::Switch,
            Self::Action(_) | Self::Bank(_) => TargetValueKind::Trigger,
            Self::Param(_) | Self::Mixer(_) => TargetValueKind::Continuous,
            Self::Track { control, .. } | Self::Strip { control, .. } => {
                if control.is_switch() {
                    TargetValueKind::Switch
                } else {
                    TargetValueKind::Continuous
                }
            }
        }
    }

    /// Track bindings live in the session (D8): a track id only exists there.
    pub fn belongs_to_session(&self) -> bool {
        matches!(self, Self::Track { .. })
    }
}

/// Message → the targets bound to it (D4).
#[derive(Debug, Clone, Default)]
pub struct MidiBindingIndex {
    entries: HashMap<MidiControlKey, Vec<(MidiTarget, MidiBinding)>>,
}

impl MidiBindingIndex {
    /// Build from (key, binding) pairs: app settings chained with the
    /// session's. Keys that do not parse are skipped, not fatal: an old build
    /// may have written a target this one does not know.
    pub fn build<'a, I>(entries: I) -> Self
    where
        I: IntoIterator<Item = (&'a String, &'a MidiBinding)>,
    {
        let mut index = Self::default();
        for (key, binding) in entries {
            index.insert(key, binding);
        }
        index
    }

    fn insert(&mut self, key: &str, binding: &MidiBinding) {
        let Some(target) = MidiTarget::parse(key) else {
            return;
        };
        let binding = binding.clone().migrated();
        let entry = self.entries.entry(binding.control_key()).or_default();
        entry.push((target, binding));
        // Deterministic order whatever the table's iteration order.
        entry.sort_by_key(|(target, _)| target.key());
    }

    pub fn lookup(&self, status: u8, data1: u8) -> &[(MidiTarget, MidiBinding)] {
        self.entries
            .get(&MidiControlKey::from_message(status, data1))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.values().map(Vec::len).sum()
    }
}

/// The on-screen fader taper, ported from `packages/shared/src/faderScale.ts`
/// (the source of truth; keep the two in step). A physical fader at position
/// p must land where the on-screen one does at p.
pub mod fader {
    pub const DB_FLOOR: f64 = -60.0;
    pub const UNITY_POSITION: f64 = 0.75;
    /// `TRACK_FADER_SCALE`.
    pub const TRACK_MAX_DB: f64 = 10.0;
    /// `AUX_FADER_SCALE` (click, voice guide).
    pub const AUX_MAX_DB: f64 = 20.0;

    const SUB_UNITY_SEGMENTS: [(f64, f64, f64, f64); 4] = [
        (0.8, 1.0, -12.0, 0.0),
        (0.5, 0.8, -30.0, -12.0),
        (0.2, 0.5, -48.0, -30.0),
        (0.0, 0.2, DB_FLOOR, -48.0),
    ];

    pub fn position_to_db(position: f64, max_db: f64) -> f64 {
        let p = position.clamp(0.0, 1.0);
        if p >= UNITY_POSITION {
            return (p - UNITY_POSITION) / (1.0 - UNITY_POSITION) * max_db;
        }
        if p <= 0.0 {
            return f64::NEG_INFINITY;
        }
        let u = p / UNITY_POSITION;
        for (u_low, u_high, db_low, db_high) in SUB_UNITY_SEGMENTS {
            if u >= u_low && u <= u_high {
                let t = (u - u_low) / (u_high - u_low);
                return db_low + t * (db_high - db_low);
            }
        }
        DB_FLOOR
    }

    pub fn db_to_position(db: f64, max_db: f64) -> f64 {
        if !db.is_finite() {
            return if db > 0.0 { 1.0 } else { 0.0 };
        }
        if db >= 0.0 {
            let t = if max_db > 0.0 { db / max_db } else { 0.0 };
            return (UNITY_POSITION + t * (1.0 - UNITY_POSITION)).clamp(0.0, 1.0);
        }
        if db <= DB_FLOOR {
            return 0.0;
        }
        for (u_low, u_high, db_low, db_high) in SUB_UNITY_SEGMENTS {
            if db >= db_low && db <= db_high {
                let t = (db - db_low) / (db_high - db_low);
                return ((u_low + t * (u_high - u_low)) * UNITY_POSITION).clamp(0.0, 1.0);
            }
        }
        0.0
    }

    pub fn position_to_gain(position: f64, max_db: f64) -> f64 {
        let db = position_to_db(position, max_db);
        if !db.is_finite() || db <= DB_FLOOR {
            return 0.0;
        }
        10f64.powf(db / 20.0)
    }

    pub fn gain_to_position(gain: f64, max_db: f64) -> f64 {
        if gain <= 0.0 {
            return 0.0;
        }
        db_to_position(20.0 * gain.log10(), max_db)
    }

    /// Pan is -1..1 on the model; a control is 0..1 with the centre at 0.5.
    pub fn position_to_pan(position: f64) -> f64 {
        (position.clamp(0.0, 1.0) * 2.0 - 1.0).clamp(-1.0, 1.0)
    }

    pub fn pan_to_position(pan: f64) -> f64 {
        ((pan.clamp(-1.0, 1.0) + 1.0) / 2.0).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
#[path = "midi_control_tests.rs"]
mod tests;
