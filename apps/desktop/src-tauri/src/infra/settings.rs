use std::{collections::HashMap, fs, io, path::{Path, PathBuf}, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::audio::engine::{
    AudioBackendKind, AudioBufferSizeRequest, AudioSampleFormat, OutputChannelRequest,
};

const SETTINGS_FILE_NAME: &str = "settings.json";

/// Linear gain, like every other aux voice. `2.0` (≈ +6 dB) is what the click
/// has always actually played at: the old model saved `0.8` and multiplied it
/// by a fixed 2.5 on the way to the engine. Keeping the audible level identical
/// across that change is the point — see `migrate_legacy_metronome_volume`.
fn default_metronome_volume() -> f64 {
    2.0
}

/// Fixed boost the click used to get between the saved setting and the engine.
pub(crate) const LEGACY_METRONOME_OUTPUT_GAIN: f64 = 2.5;

fn default_metronome_accent_enabled() -> bool {
    true
}

fn default_metronome_preset() -> i32 {
    0
}

fn default_metronome_pitch() -> f32 {
    0.0
}

fn default_metronome_subdivision() -> i32 {
    1
}

fn default_metronome_subdivision_gain() -> f32 {
    0.5
}

fn default_voice_guide_volume() -> f64 {
    1.0
}

fn default_voice_guide_lead_bars() -> i32 {
    1
}

fn default_voice_guide_count_in_enabled() -> bool {
    true
}

fn default_voice_guide_language() -> String {
    "es".to_string()
}

fn default_pad_volume() -> f64 {
    1.0
}

fn default_pad_route() -> String {
    "master".into()
}

fn default_enabled_output_channels() -> Vec<usize> {
    vec![0, 1]
}

fn default_audio_route() -> String {
    "master".into()
}

fn default_voice_guide_route() -> String {
    "monitor".into()
}

fn default_global_jump_mode() -> String {
    "immediate".into()
}

fn default_global_jump_bars() -> u32 {
    4
}

fn default_song_jump_trigger() -> String {
    "immediate".into()
}

fn default_song_jump_bars() -> u32 {
    4
}

fn default_song_transition_mode() -> String {
    "instant".into()
}

fn default_vamp_mode() -> String {
    "section".into()
}

fn default_vamp_bars() -> u32 {
    4
}

fn default_timeline_navigation_scheme() -> String {
    "ableton".into()
}

fn default_timeline_playhead_follow_mode() -> String {
    "ahead".into()
}

fn default_import_merge_matching_tracks() -> bool {
    true
}

fn default_auto_save_enabled() -> bool {
    true
}

fn default_auto_save_interval_minutes() -> u32 {
    5
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MidiBinding {
    pub status: u8,
    pub data1: u8,
    pub is_cc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub selected_output_device: Option<String>,
    #[serde(default)]
    pub selected_audio_backend: Option<AudioBackendKind>,
    #[serde(default)]
    pub selected_output_device_id: Option<String>,
    #[serde(default)]
    pub selected_output_device_name: Option<String>,
    #[serde(default)]
    pub output_sample_rate: Option<u32>,
    #[serde(default)]
    pub output_buffer_size: AudioBufferSizeRequest,
    #[serde(default)]
    pub output_channel_mapping: OutputChannelRequest,
    #[serde(default)]
    pub output_sample_format: Option<AudioSampleFormat>,
    #[serde(default)]
    pub audio_safe_mode: bool,
    /// Android only: open the output stream in AAudio low-latency mode
    /// (Oboe `PerformanceMode::LowLatency`) instead of the default deep-buffer
    /// mode. Off by default because low-latency streams get small internal
    /// buffers that underran ("petardeo") on low-end phones; the user opts in
    /// when they have hardware that can take it (e.g. a USB interface). Ignored
    /// on desktop, which negotiates latency through buffer size.
    #[serde(default)]
    pub low_latency_output: bool,
    /// Reducir el trabajo de audio a un solo hilo.
    ///
    /// Es el interruptor de "si cruje, prueba esto" de la pestaña Diagnóstico.
    /// Apagado, el motor reparte el render entre varios hilos según la máquina
    /// (~3,7x más margen con 4 hilos, medido). Encendido, vuelve al camino de un
    /// solo hilo, que es el comportamiento de siempre.
    ///
    /// Existe porque el usuario que reportó el problema no tiene por qué saber
    /// abrir una terminal: la alternativa era una variable de entorno.
    #[serde(default)]
    pub audio_single_thread_render: bool,
    #[serde(default)]
    pub selected_midi_device: Option<String>,
    /// Port the timeline's MIDI tracks send to. Separate from
    /// `selected_midi_device` (input): sending to a lighting desk and receiving
    /// from a foot controller are independent choices.
    #[serde(default)]
    pub selected_midi_output_device: Option<String>,
    #[serde(default)]
    pub suppress_missing_midi_device_warning: bool,
    #[serde(default = "default_enabled_output_channels")]
    pub enabled_output_channels: Vec<usize>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub metronome_enabled: bool,
    #[serde(default = "default_metronome_volume")]
    pub metronome_volume: f64,
    #[serde(default = "default_audio_route")]
    pub metronome_output: String,
    #[serde(default = "default_metronome_accent_enabled")]
    pub metronome_accent_enabled: bool,
    #[serde(default = "default_metronome_preset")]
    pub metronome_accent_preset: i32,
    #[serde(default = "default_metronome_preset")]
    pub metronome_beat_preset: i32,
    #[serde(default = "default_metronome_pitch")]
    pub metronome_accent_pitch: f32,
    #[serde(default = "default_metronome_pitch")]
    pub metronome_beat_pitch: f32,
    #[serde(default = "default_metronome_subdivision")]
    pub metronome_subdivision: i32,
    #[serde(default = "default_metronome_preset")]
    pub metronome_subdivision_preset: i32,
    #[serde(default = "default_metronome_pitch")]
    pub metronome_subdivision_pitch: f32,
    #[serde(default = "default_metronome_subdivision_gain")]
    pub metronome_subdivision_gain: f32,
    #[serde(default)]
    pub voice_guide_enabled: bool,
    #[serde(default = "default_voice_guide_route")]
    pub voice_guide_output: String,
    #[serde(default = "default_voice_guide_volume")]
    pub voice_guide_volume: f64,
    #[serde(default = "default_voice_guide_lead_bars")]
    pub voice_guide_lead_bars: i32,
    #[serde(default = "default_voice_guide_count_in_enabled")]
    pub voice_guide_count_in_enabled: bool,
    #[serde(default = "default_voice_guide_language")]
    pub voice_guide_language: String,
    #[serde(default)]
    pub pad_enabled: bool,
    /// Installed pad folder name currently selected (empty = none).
    #[serde(default)]
    pub pad_id: String,
    /// Selected key, 0..11 (C..B).
    #[serde(default)]
    pub pad_key: i32,
    #[serde(default = "default_pad_volume")]
    pub pad_volume: f64,
    #[serde(default = "default_pad_route")]
    pub pad_output: String,
    /// Soft-entrance duration in seconds when the pad is enabled. 0 keeps the
    /// near-instant default entrance.
    #[serde(default)]
    pub pad_fade_in_seconds: f64,
    /// Soft-exit duration in seconds when the pad is disabled or its key/pack
    /// changes. 0 keeps the fast performance swap.
    #[serde(default)]
    pub pad_fade_out_seconds: f64,
    /// When true, the pad's key is driven by the song's tonic (the region under
    /// the playhead), following transpose changes, instead of the manual key
    /// grid. The frontend owns the mapping and pushes `pad_key`; this flag only
    /// persists the user's choice.
    #[serde(default)]
    pub pad_follow_song_key: bool,
    /// When true the pad follows the transport: it fades out (using
    /// `pad_fade_out_seconds`) when playback stops/pauses and comes back on
    /// play, WITHOUT clearing `pad_enabled` — the switch stays on. Default
    /// false: pads are otherwise decoupled from the transport and keep sounding
    /// between songs, which is the point of an ambient pad.
    #[serde(default)]
    pub pad_stop_with_transport: bool,
    #[serde(default = "default_global_jump_mode")]
    pub global_jump_mode: String,
    #[serde(default = "default_global_jump_bars")]
    pub global_jump_bars: u32,
    #[serde(default = "default_song_jump_trigger")]
    pub song_jump_trigger: String,
    #[serde(default = "default_song_jump_bars")]
    pub song_jump_bars: u32,
    #[serde(default = "default_song_transition_mode")]
    pub song_transition_mode: String,
    #[serde(default = "default_vamp_mode")]
    pub vamp_mode: String,
    #[serde(default = "default_vamp_bars")]
    pub vamp_bars: u32,
    #[serde(default = "default_timeline_navigation_scheme")]
    pub timeline_navigation_scheme: String,
    #[serde(default = "default_timeline_playhead_follow_mode")]
    pub timeline_playhead_follow_mode: String,
    /// When true (default), importing a `.ltpkg` whose track name and kind
    /// already exist in the session appends its clips onto that existing track,
    /// keeping one lane per instrument across every song. When false each
    /// imported song brings its own tracks, even if two songs both call a track
    /// "Bateria" — what users who order their set song by song expect.
    #[serde(default = "default_import_merge_matching_tracks")]
    pub import_merge_matching_tracks: bool,
    /// When true (default) the frontend saves the loaded session on its own
    /// every `auto_save_interval_minutes`, so a crash or power cut costs at most
    /// one interval of work. The timer lives in the UI (it needs the project
    /// revision to know whether anything actually changed); these two fields
    /// only persist the user's choice.
    #[serde(default = "default_auto_save_enabled")]
    pub auto_save_enabled: bool,
    #[serde(default = "default_auto_save_interval_minutes")]
    pub auto_save_interval_minutes: u32,
    #[serde(default)]
    pub midi_mappings: HashMap<String, MidiBinding>,
    /// Custom location for the decoded-PCM cache (`.rf64` files written when a
    /// non-WAV source is decoded). `None` = OS default cache dir. Maps to the
    /// engine's `LIBRETRACKS_CACHE_DIR` env override.
    #[serde(default)]
    pub decoding_cache_dir: Option<String>,
    /// Maximum decoding-cache size in GiB. `None` = automatic policy (the engine
    /// uses 10% of free disk, min 4 GiB). Maps to `LIBRETRACKS_SOURCE_DISK_CACHE_MB`.
    #[serde(default)]
    pub decoding_cache_max_gb: Option<u32>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            selected_output_device: None,
            selected_audio_backend: None,
            selected_output_device_id: None,
            selected_output_device_name: None,
            output_sample_rate: None,
            output_buffer_size: AudioBufferSizeRequest::Default,
            output_channel_mapping: OutputChannelRequest::default(),
            output_sample_format: None,
            audio_safe_mode: false,
            low_latency_output: false,
            audio_single_thread_render: false,
            selected_midi_device: None,
            selected_midi_output_device: None,
            suppress_missing_midi_device_warning: false,
            enabled_output_channels: default_enabled_output_channels(),
            locale: None,
            metronome_enabled: false,
            metronome_volume: default_metronome_volume(),
            metronome_output: default_audio_route(),
            metronome_accent_enabled: default_metronome_accent_enabled(),
            metronome_accent_preset: default_metronome_preset(),
            metronome_beat_preset: default_metronome_preset(),
            metronome_accent_pitch: default_metronome_pitch(),
            metronome_beat_pitch: default_metronome_pitch(),
            metronome_subdivision: default_metronome_subdivision(),
            metronome_subdivision_preset: default_metronome_preset(),
            metronome_subdivision_pitch: default_metronome_pitch(),
            metronome_subdivision_gain: default_metronome_subdivision_gain(),
            voice_guide_enabled: false,
            voice_guide_output: default_voice_guide_route(),
            voice_guide_volume: default_voice_guide_volume(),
            voice_guide_lead_bars: default_voice_guide_lead_bars(),
            voice_guide_count_in_enabled: default_voice_guide_count_in_enabled(),
            voice_guide_language: default_voice_guide_language(),
            pad_enabled: false,
            pad_id: String::new(),
            pad_key: 0,
            pad_volume: default_pad_volume(),
            pad_output: default_pad_route(),
            pad_fade_in_seconds: 0.0,
            pad_fade_out_seconds: 0.0,
            pad_follow_song_key: false,
            pad_stop_with_transport: false,
            global_jump_mode: default_global_jump_mode(),
            global_jump_bars: default_global_jump_bars(),
            song_jump_trigger: default_song_jump_trigger(),
            song_jump_bars: default_song_jump_bars(),
            song_transition_mode: default_song_transition_mode(),
            vamp_mode: default_vamp_mode(),
            vamp_bars: default_vamp_bars(),
            timeline_navigation_scheme: default_timeline_navigation_scheme(),
            timeline_playhead_follow_mode: default_timeline_playhead_follow_mode(),
            import_merge_matching_tracks: default_import_merge_matching_tracks(),
            auto_save_enabled: default_auto_save_enabled(),
            auto_save_interval_minutes: default_auto_save_interval_minutes(),
            midi_mappings: HashMap::new(),
            decoding_cache_dir: None,
            decoding_cache_max_gb: None,
        }
    }
}

/// Apply the decoding-cache preferences to the process environment so the audio
/// engine (which reads these env vars lazily on every cache operation) picks
/// them up. Call at startup before the engine is first used, and again whenever
/// the settings change — the native side re-reads `std::getenv` each call, so a
/// live update takes effect without restarting.
///
/// Note: changing the folder does NOT migrate existing `.rf64` files — the old
/// directory keeps its contents until purged (matches Ableton Live's behaviour).
pub fn default_decoding_cache_dir(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(local_app_data)
                .join("LibreTracks")
                .join("cache");
        }
    }

    // Android: next to the sessions, in the app-specific EXTERNAL dir — the
    // same place `state::project_root` picks, and for the same reason. The
    // generic branch below lands on INTERNAL storage, which is the volume that
    // fills up first on a modest phone, and the cache of a multi-GB session is
    // the heaviest thing we write. Sessions on one volume and their decoded
    // audio on another was never deliberate. Falls through when the external
    // volume is unavailable, exactly like the session root does.
    #[cfg(target_os = "android")]
    if let Some(external) = crate::platform::android_storage::external_files_dir() {
        return external.join("cache");
    }

    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("LibreTracks"))
        .join("cache")
}

/// Cache roots this build no longer writes to, but earlier ones did.
///
/// Android moved the cache from internal storage to the app's external dir
/// (see above). Whatever the old builds left behind is then invisible to the
/// app: the size readout ignores it and "Clear cache" cannot reach it, so it
/// sits there forever on the volume that runs out of space first. Reporting
/// and purging still cover these, so the move does not strand gigabytes.
///
/// Empty on every other platform, and empty on Android when the fallback means
/// the legacy root IS the effective one.
pub fn legacy_decoding_cache_dirs(app: &AppHandle, effective: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "android")]
    {
        let internal = app
            .path()
            .app_local_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("LibreTracks"))
            .join("cache");
        if crate::state::same_dir(&internal, effective) {
            return Vec::new();
        }
        return vec![internal];
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, effective);
        Vec::new()
    }
}

pub fn effective_decoding_cache_dir(app: &AppHandle, settings: &AppSettings) -> PathBuf {
    settings
        .decoding_cache_dir
        .as_deref()
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_decoding_cache_dir(app))
}

pub fn apply_decoding_cache_env(app: &AppHandle, settings: &AppSettings) {
    std::env::set_var(
        "LIBRETRACKS_CACHE_DIR",
        effective_decoding_cache_dir(app, settings),
    );
    match settings.decoding_cache_max_gb {
        // The engine override is expressed in MiB.
        Some(gb) => std::env::set_var(
            "LIBRETRACKS_SOURCE_DISK_CACHE_MB",
            (u64::from(gb) * 1024).to_string(),
        ),
        None => std::env::remove_var("LIBRETRACKS_SOURCE_DISK_CACHE_MB"),
    }
}

impl AppSettings {
    /// Convert a click volume saved under the old model into a linear gain.
    ///
    /// Until the click fader became a dB scale, the saved value was a 0..1
    /// slider position that the engine path multiplied by a fixed 2.5. The
    /// setting now IS the gain, so a stored `0.8` has to become `2.0` or every
    /// existing user's click would suddenly drop by ~8 dB on upgrade.
    ///
    /// `<= 1.0` is the tell: the old path clamped to 1.0 before scaling, so no
    /// legacy file can hold more than that, while any value the dB fader writes
    /// above unity is already a real gain. The one ambiguous case is exactly
    /// `1.0` (legacy maximum, or 0 dB written by the new fader) — it is treated
    /// as legacy, preserving the audible level for the many upgrading users at
    /// the cost of nudging a deliberate 0 dB up to +8 dB for the few who set it
    /// during 1.10, who can simply pull the fader back down.
    pub(crate) fn migrate_legacy_metronome_volume(&mut self) {
        if self.metronome_volume <= 1.0 {
            self.metronome_volume =
                (self.metronome_volume * LEGACY_METRONOME_OUTPUT_GAIN).clamp(0.0, 10.0);
        }
    }
}

pub struct AppSettingsStore {
    settings: Mutex<AppSettings>,
}

impl AppSettingsStore {
    pub fn new(settings: AppSettings) -> Self {
        Self {
            settings: Mutex::new(settings),
        }
    }

    pub fn current(&self) -> Result<AppSettings, io::Error> {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| io::Error::other("settings state lock poisoned"))
    }

    pub fn set(&self, settings: AppSettings) -> Result<(), io::Error> {
        let mut current = self
            .settings
            .lock()
            .map_err(|_| io::Error::other("settings state lock poisoned"))?;
        *current = settings;
        Ok(())
    }
}

pub fn load_app_settings(app: &AppHandle) -> Result<AppSettings, io::Error> {
    let settings_path = settings_file_path(app)?;
    if !settings_path.exists() {
        return Ok(AppSettings::default());
    }

    let contents = fs::read_to_string(settings_path)?;
    let mut settings: AppSettings =
        serde_json::from_str(&contents).map_err(|error| io::Error::other(error.to_string()))?;
    settings.migrate_legacy_metronome_volume();
    Ok(settings)
}

/// Build the settings used by a fresh process. The PAD's on/off switch is a
/// live-performance latch, not a durable preference: always start silent while
/// retaining the selected pad, key, routing, gain and fade configuration.
pub fn runtime_settings_for_startup(mut settings: AppSettings) -> AppSettings {
    settings.pad_enabled = false;
    settings
}

pub fn save_app_settings(app: &AppHandle, settings: &AppSettings) -> Result<PathBuf, io::Error> {
    let settings_path = settings_file_path(app)?;
    if let Some(parent_dir) = settings_path.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    let contents = serde_json::to_string_pretty(settings)
        .map_err(|error| io::Error::other(error.to_string()))?;
    fs::write(&settings_path, contents)?;
    Ok(settings_path)
}

fn settings_file_path(app: &AppHandle) -> Result<PathBuf, io::Error> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(app_data_dir.join(SETTINGS_FILE_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_turns_the_pad_off_without_losing_its_configuration() {
        let saved = AppSettings {
            pad_enabled: true,
            pad_id: "warm".into(),
            pad_key: 7,
            pad_volume: 1.8,
            pad_output: "out:3-4".into(),
            pad_fade_in_seconds: 2.5,
            pad_fade_out_seconds: 4.0,
            pad_follow_song_key: true,
            pad_stop_with_transport: true,
            ..AppSettings::default()
        };
        let mut expected = saved.clone();
        expected.pad_enabled = false;

        assert_eq!(runtime_settings_for_startup(saved), expected);
    }

    /// Upgrading must not change how loud the click actually is: a legacy `0.8`
    /// played at `0.8 * 2.5 = 2.0`, so it has to land on exactly `2.0` now.
    #[test]
    fn legacy_metronome_volume_keeps_the_same_audible_level() {
        let mut settings = AppSettings {
            metronome_volume: 0.8,
            ..AppSettings::default()
        };
        settings.migrate_legacy_metronome_volume();
        assert_eq!(settings.metronome_volume, 2.0);

        let mut silent = AppSettings {
            metronome_volume: 0.0,
            ..AppSettings::default()
        };
        silent.migrate_legacy_metronome_volume();
        assert_eq!(silent.metronome_volume, 0.0);
    }

    /// Values the dB fader wrote above unity are already real gains and must be
    /// left exactly as they are — double-scaling them would be a loud surprise.
    #[test]
    fn migration_leaves_new_model_gains_untouched() {
        for gain in [1.5, 2.0, 5.0, 10.0] {
            let mut settings = AppSettings {
                metronome_volume: gain,
                ..AppSettings::default()
            };
            settings.migrate_legacy_metronome_volume();
            assert_eq!(settings.metronome_volume, gain);
        }
    }

    /// Running the migration twice must not compound (a settings file is loaded
    /// once per launch, but the guard is what makes that safe).
    #[test]
    fn migration_is_idempotent() {
        let mut settings = AppSettings {
            metronome_volume: 0.8,
            ..AppSettings::default()
        };
        settings.migrate_legacy_metronome_volume();
        let once = settings.metronome_volume;
        settings.migrate_legacy_metronome_volume();
        assert_eq!(settings.metronome_volume, once);
    }

    #[test]
    fn default_settings_match_the_documented_values() {
        let settings = AppSettings::default();
        assert!(!settings.metronome_enabled);
        // Linear gain now, not a 0..1 slider scaled by 2.5 on the way out.
        // 2.0 is the same audible level the old `0.8` produced.
        assert_eq!(settings.metronome_volume, 2.0);
        assert_eq!(settings.metronome_output, "master");
        assert_eq!(settings.voice_guide_output, "monitor");
        assert_eq!(settings.enabled_output_channels, vec![0, 1]);
        assert_eq!(settings.global_jump_mode, "immediate");
        assert_eq!(settings.global_jump_bars, 4);
        assert_eq!(settings.vamp_mode, "section");
        assert_eq!(settings.timeline_navigation_scheme, "ableton");
        assert!(settings.import_merge_matching_tracks);
        assert!(settings.midi_mappings.is_empty());
    }

    #[test]
    fn import_merge_matching_tracks_defaults_to_true_for_older_settings_files() {
        // The field postdates existing installs; a settings file without it must
        // keep the historical merge-on-import behaviour rather than silently
        // switching every user to separate tracks.
        let settings: AppSettings = serde_json::from_str("{}").expect("defaults");
        assert!(settings.import_merge_matching_tracks);

        let settings: AppSettings =
            serde_json::from_str(r#"{ "importMergeMatchingTracks": false }"#).expect("explicit");
        assert!(!settings.import_merge_matching_tracks);
    }

    #[test]
    fn auto_save_defaults_to_on_every_five_minutes_for_older_settings_files() {
        // Autosave postdates existing installs; a settings file without the
        // fields must still get the protection rather than silently staying off.
        let settings: AppSettings = serde_json::from_str("{}").expect("defaults");
        assert!(settings.auto_save_enabled);
        assert_eq!(settings.auto_save_interval_minutes, 5);

        let settings: AppSettings = serde_json::from_str(
            r#"{ "autoSaveEnabled": false, "autoSaveIntervalMinutes": 10 }"#,
        )
        .expect("explicit");
        assert!(!settings.auto_save_enabled);
        assert_eq!(settings.auto_save_interval_minutes, 10);
    }

    #[test]
    fn deserializing_an_empty_object_fills_every_default() {
        // The settings file may predate any given field; serde defaults keep
        // older files loadable. An empty object must yield the full defaults.
        let settings: AppSettings = serde_json::from_str("{}").expect("defaults");
        assert_eq!(settings, AppSettings::default());
    }

    #[test]
    fn deserializing_a_partial_object_overrides_only_named_fields() {
        let json = r#"{ "metronomeEnabled": true, "globalJumpBars": 8 }"#;
        let settings: AppSettings = serde_json::from_str(json).expect("partial");
        assert!(settings.metronome_enabled);
        assert_eq!(settings.global_jump_bars, 8);
        // Untouched fields stay at their defaults.
        assert_eq!(settings.metronome_volume, 2.0);
        assert_eq!(settings.vamp_bars, 4);
    }

    #[test]
    fn settings_round_trip_through_json() {
        let mut settings = AppSettings::default();
        settings.locale = Some("es".into());
        settings.metronome_volume = 0.42;
        settings.midi_mappings.insert(
            "play".into(),
            MidiBinding {
                status: 0x90,
                data1: 60,
                is_cc: false,
            },
        );
        let json = serde_json::to_string(&settings).expect("serialize");
        let restored: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, settings);
    }

    #[test]
    fn camel_case_field_names_are_used_on_the_wire() {
        let json = serde_json::to_string(&AppSettings::default()).expect("serialize");
        assert!(json.contains("metronomeVolume"));
        assert!(json.contains("globalJumpMode"));
        assert!(!json.contains("metronome_volume"));
    }

    #[test]
    fn midi_binding_uses_camel_case_is_cc() {
        let json = serde_json::to_string(&MidiBinding {
            status: 1,
            data1: 2,
            is_cc: true,
        })
        .expect("serialize");
        assert!(json.contains("isCc"));
    }

    #[test]
    fn decoding_cache_fields_default_to_none_and_survive_empty_object() {
        // Older settings files predate these fields; an empty object must still
        // deserialize and leave them unset (= OS default dir / automatic limit).
        let settings: AppSettings = serde_json::from_str("{}").expect("defaults");
        assert_eq!(settings.decoding_cache_dir, None);
        assert_eq!(settings.decoding_cache_max_gb, None);
    }

    #[test]
    fn decoding_cache_fields_round_trip() {
        let mut settings = AppSettings::default();
        settings.decoding_cache_dir = Some("D:/lt-cache".into());
        settings.decoding_cache_max_gb = Some(8);
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains("decodingCacheDir"));
        assert!(json.contains("decodingCacheMaxGb"));
        let restored: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, settings);
    }

    #[test]
    fn settings_store_reads_back_what_was_set() {
        let store = AppSettingsStore::new(AppSettings::default());
        assert_eq!(store.current().unwrap().metronome_volume, 2.0);

        let mut next = AppSettings::default();
        next.metronome_volume = 0.1;
        store.set(next).unwrap();
        assert_eq!(store.current().unwrap().metronome_volume, 0.1);
    }
}
