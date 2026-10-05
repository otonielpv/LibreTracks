//! What the native video code (Kotlin on Android, Swift on iOS) reports, in
//! the output's terms (plan `video-mobile`, pasos 03, 05 and 06).
//!
//! Compiled on every platform on purpose, like `platform::storage_volumes`:
//! the JNI and FFI entry points in `platform/android_video.rs` and
//! `platform/ios_video.rs` sit behind a `cfg` that no desktop `cargo check` or
//! test ever sees, so they only copy numbers and strings across and call
//! [`decode_event`] / [`parse_displays`] / [`emit`] here. Everything that
//! decides something is in this file and tested.

use std::sync::{Mutex, OnceLock};

use libretracks_video::monitors::MonitorInfo;
use libretracks_video::native::NativeEventSink;
use libretracks_video::output::{BackendEvent, Slot};

/// Event kinds, shared with `VideoOutputBridge.kt` and
/// `VideoOutputBridge.swift`. Append only: the numbers cross the bridge.
pub mod kind {
    pub const FILE_LOADED: i32 = 0;
    pub const PLAYBACK_RESTART: i32 = 1;
    pub const LOAD_FAILED: i32 = 2;
    pub const FRAME_DROPS: i32 = 3;
    pub const CLOSED: i32 = 4;
    /// `slot` is 1 when the second player was created, 0 when it failed;
    /// `text` is the native reason.
    pub const SECOND_PLAYER: i32 = 5;
    pub const SUSPENDED: i32 = 6;
    pub const RESUMED: i32 = 7;
    /// The surface could not be created on the display; `text` says why.
    pub const SURFACE_FAILED: i32 = 8;
}

fn slot_from(raw: i32) -> Slot {
    if raw == 1 {
        Slot::B
    } else {
        Slot::A
    }
}

/// Whether to run with one player or two after the native side tried to
/// create the second one (paso 05 §4), and the note the status shows.
///
/// A low-end SoC may have one hardware video decoder in all (shared with the
/// MediaCodec audio of the offline render). Then the second `ExoPlayer`
/// fails, is released, and jumps are served by seeking the only player: they
/// may freeze for an instant, which the technician must know before the show.
pub fn second_player_decision(created: bool, reason: Option<&str>) -> (bool, Option<String>) {
    if created {
        return (true, None);
    }
    let mut note =
        String::from("Un solo reproductor: los saltos pueden congelar la imagen un instante");
    if let Some(reason) = reason.map(str::trim).filter(|reason| !reason.is_empty()) {
        note.push_str(" (");
        note.push_str(reason);
        note.push(')');
    }
    (false, Some(note))
}

/// One event from the native side, or `None` for a kind this build does not
/// know (a newer native part than Rust: ignored, never a panic).
pub fn decode_event(kind: i32, slot: i32, text: Option<&str>) -> Option<BackendEvent> {
    let slot_value = slot_from(slot);
    let text_value = || text.unwrap_or_default().to_string();
    Some(match kind {
        kind::FILE_LOADED => BackendEvent::FileLoaded { slot: slot_value },
        kind::PLAYBACK_RESTART => BackendEvent::PlaybackRestart { slot: slot_value },
        kind::LOAD_FAILED => BackendEvent::LoadFailed {
            slot: slot_value,
            reason: if text.is_some_and(|text| !text.is_empty()) {
                text_value()
            } else {
                "el vídeo no se pudo abrir".into()
            },
        },
        kind::FRAME_DROPS => BackendEvent::FrameDrops {
            slot: slot_value,
            count: text.and_then(|text| text.trim().parse().ok()).unwrap_or(0),
        },
        kind::CLOSED => BackendEvent::Closed,
        kind::SECOND_PLAYER => {
            let (available, note) = second_player_decision(slot == 1, text);
            BackendEvent::DualPlayers { available, note }
        }
        kind::SUSPENDED => BackendEvent::Suspended,
        kind::RESUMED => BackendEvent::Resumed,
        kind::SURFACE_FAILED => {
            BackendEvent::SurfaceFailed(if text.is_some_and(|t| !t.is_empty()) {
                text_value()
            } else {
                "no se pudo abrir la salida en la pantalla externa".into()
            })
        }
        _ => return None,
    })
}

/// The external displays, one per line as `name<TAB>width<TAB>height`. The
/// phone's own screen never comes in the list (paso 06 §1). Malformed lines
/// are skipped; a display with no name is called "Pantalla externa".
pub fn parse_displays(text: &str) -> Vec<MonitorInfo> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let name = fields.next()?.trim();
            let width = fields.next()?.trim().parse().ok()?;
            let height = fields.next()?.trim().parse().ok()?;
            Some(MonitorInfo {
                name: if name.is_empty() {
                    "Pantalla externa".into()
                } else {
                    name.to_string()
                },
                width,
                height,
                x: 0,
                y: 0,
                is_primary: false,
            })
        })
        .collect()
}

/// The external displays the native side reported last, for the settings
/// tab and the wizard (paso 10), and who wants to hear about changes.
static LAST_DISPLAYS: Mutex<Vec<MonitorInfo>> = Mutex::new(Vec::new());
type DisplaysListener = Box<dyn Fn(&[MonitorInfo]) + Send + Sync>;
static DISPLAYS_LISTENER: OnceLock<DisplaysListener> = OnceLock::new();

/// Called by the platform adapters with a new list: remembered, handed to the
/// output and to the listener (the `video:displays` event).
pub fn displays_changed(displays: Vec<MonitorInfo>) {
    if let Ok(mut last) = LAST_DISPLAYS.lock() {
        last.clone_from(&displays);
    }
    if let Some(listener) = DISPLAYS_LISTENER.get() {
        listener(&displays);
    }
    emit(BackendEvent::DisplaysChanged(displays));
}

pub fn last_displays() -> Vec<MonitorInfo> {
    LAST_DISPLAYS
        .lock()
        .map(|displays| displays.clone())
        .unwrap_or_default()
}

/// Set once, at startup, by the app.
pub fn set_displays_listener(listener: DisplaysListener) {
    let _ = DISPLAYS_LISTENER.set(listener);
}

static SINK: OnceLock<Mutex<Option<NativeEventSink>>> = OnceLock::new();

fn sink() -> &'static Mutex<Option<NativeEventSink>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// Where native events go from now on (the output thread's backend).
pub fn install_sink(new_sink: NativeEventSink) {
    if let Ok(mut current) = sink().lock() {
        *current = Some(new_sink);
    }
}

/// Hand an event to the output. Called from the JNI/FFI callbacks: a channel
/// send, nothing else. Before the output starts, events are dropped (the
/// native side repeats the display list when the output opens).
pub fn emit(event: BackendEvent) {
    if let Ok(current) = sink().lock() {
        if let Some(sink) = current.as_ref() {
            sink.send(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_kind_decodes() {
        assert_eq!(
            decode_event(kind::FILE_LOADED, 1, None),
            Some(BackendEvent::FileLoaded { slot: Slot::B })
        );
        assert_eq!(
            decode_event(kind::PLAYBACK_RESTART, 0, None),
            Some(BackendEvent::PlaybackRestart { slot: Slot::A })
        );
        assert_eq!(
            decode_event(kind::LOAD_FAILED, 0, Some("Decoder init failed: hevc")),
            Some(BackendEvent::LoadFailed {
                slot: Slot::A,
                reason: "Decoder init failed: hevc".into()
            })
        );
        assert_eq!(
            decode_event(kind::FRAME_DROPS, 1, Some("12")),
            Some(BackendEvent::FrameDrops {
                slot: Slot::B,
                count: 12
            })
        );
        assert_eq!(
            decode_event(kind::CLOSED, 0, None),
            Some(BackendEvent::Closed)
        );
        assert_eq!(
            decode_event(kind::SUSPENDED, 0, None),
            Some(BackendEvent::Suspended)
        );
        assert_eq!(
            decode_event(kind::RESUMED, 0, None),
            Some(BackendEvent::Resumed)
        );
        assert!(matches!(
            decode_event(kind::SURFACE_FAILED, 0, Some("")),
            Some(BackendEvent::SurfaceFailed(ref reason)) if !reason.is_empty()
        ));
    }

    #[test]
    fn a_load_failure_without_text_still_says_something() {
        assert!(matches!(
            decode_event(kind::LOAD_FAILED, 0, None),
            Some(BackendEvent::LoadFailed { ref reason, .. }) if !reason.is_empty()
        ));
    }

    #[test]
    fn an_unknown_kind_is_ignored_not_a_panic() {
        assert_eq!(decode_event(99, 0, Some("x")), None);
    }

    /// Paso 05 C4: the one/two players decision and its message.
    #[test]
    fn a_second_player_that_was_created_means_two_players_and_no_note() {
        assert_eq!(second_player_decision(true, Some("ignored")), (true, None));
        assert_eq!(
            decode_event(kind::SECOND_PLAYER, 1, None),
            Some(BackendEvent::DualPlayers {
                available: true,
                note: None
            })
        );
    }

    #[test]
    fn a_second_player_that_failed_means_one_player_and_says_why() {
        let (available, note) =
            second_player_decision(false, Some("MediaCodecVideoRenderer error: NO_MEMORY"));
        assert!(!available);
        let note = note.expect("a note");
        assert!(note.starts_with("Un solo reproductor"));
        assert!(note.contains("congelar"));
        assert!(note.ends_with("(MediaCodecVideoRenderer error: NO_MEMORY)"));

        let (_, bare) = second_player_decision(false, Some("  "));
        assert_eq!(
            bare.as_deref(),
            Some("Un solo reproductor: los saltos pueden congelar la imagen un instante")
        );
    }

    #[test]
    fn the_last_display_list_is_remembered_for_the_settings() {
        displays_changed(parse_displays("HDMI\t1920\t1080"));
        assert_eq!(last_displays().len(), 1);
        assert_eq!(last_displays()[0].name, "HDMI");
        displays_changed(Vec::new());
        assert!(last_displays().is_empty());
    }

    #[test]
    fn displays_parse_from_tab_separated_lines() {
        let displays = parse_displays(
            "HDMI\t1920\t1080\n\nAirPlay: Salón\t1280\t720\nbroken line\n\t3840\t2160",
        );
        let names: Vec<&str> = displays.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["HDMI", "AirPlay: Salón", "Pantalla externa"]);
        assert_eq!((displays[1].width, displays[1].height), (1280, 720));
        assert!(displays
            .iter()
            .all(|d| d.x == 0 && d.y == 0 && !d.is_primary));
        assert!(parse_displays("").is_empty());
    }
}
