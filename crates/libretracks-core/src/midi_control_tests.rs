use std::collections::{BTreeMap, HashMap};

use super::fader::{gain_to_position, pan_to_position, position_to_gain, position_to_pan};
use super::*;

fn old(json: &str) -> MidiBinding {
    serde_json::from_str::<MidiBinding>(json)
        .expect("old binding parses")
        .migrated()
}

// --- Migration: one test per shape the old learn could have stored. ---

#[test]
fn old_cc_binding_keeps_working_as_an_absolute_control() {
    let binding = old(r#"{"status":176,"data1":7,"isCc":true}"#);
    assert_eq!(binding.kind(), MidiMessageKind::ControlChange);
    assert_eq!(binding.min, 0.0);
    assert_eq!(binding.max, 1.0);
    assert!(!binding.invert);
    assert!(binding.takeover_enabled());
    assert_eq!(
        binding.effective_mode(&MidiTarget::parse("param:metronome_volume").unwrap()),
        ControlMode::Absolute
    );
}

#[test]
fn old_note_on_binding_triggers_its_action() {
    let binding = old(r#"{"status":144,"data1":60,"isCc":false}"#);
    assert_eq!(binding.kind(), MidiMessageKind::Note);
    assert_eq!(
        binding.effective_mode(&MidiTarget::parse("action:play").unwrap()),
        ControlMode::Trigger
    );
}

#[test]
fn old_binding_learned_from_a_note_off_matches_the_press() {
    // The old learn bound the first message it saw, so a button whose release
    // arrived first was stored as 0x8n and never fired again on press.
    let binding = old(r#"{"status":130,"data1":36,"isCc":false}"#);
    assert_eq!(binding.status, 0x92);
    let index = MidiBindingIndex::build(
        [("action:play".to_string(), binding)]
            .iter()
            .map(|(key, binding)| (key, binding)),
    );
    assert_eq!(index.lookup(0x92, 36).len(), 1);
    assert_eq!(index.lookup(0x82, 36).len(), 1);
}

#[test]
fn old_binding_with_a_wrong_is_cc_flag_follows_its_status() {
    let binding = old(r#"{"status":177,"data1":20,"isCc":false}"#);
    assert!(binding.is_cc);
    let binding = old(r#"{"status":144,"data1":20,"isCc":true}"#);
    assert!(!binding.is_cc);
}

#[test]
fn old_settings_table_round_trips_without_new_fields() {
    // A user who never touches the new options must get the old file back.
    let json = r#"{"status":176,"data1":7,"isCc":true}"#;
    let binding: MidiBinding = serde_json::from_str(json).unwrap();
    assert_eq!(serde_json::to_string(&binding).unwrap(), json);
}

#[test]
fn hand_edited_range_is_clamped_and_relative_on_a_note_is_dropped() {
    let binding = old(
        r#"{"status":144,"data1":1,"isCc":false,"min":-3,"max":9,"mode":"relativeTwosComplement"}"#,
    );
    assert_eq!(binding.min, 0.0);
    assert_eq!(binding.max, 1.0);
    assert_eq!(binding.mode, None);
}

// --- Index ---

#[test]
fn index_matches_on_type_channel_and_number() {
    let mut settings = HashMap::new();
    settings.insert("param:tempo".to_string(), MidiBinding::new(0xB0, 7));
    let index = MidiBindingIndex::build(settings.iter());
    assert_eq!(index.lookup(0xB0, 7).len(), 1);
    assert!(index.lookup(0xB1, 7).is_empty(), "other channel");
    assert!(index.lookup(0xB0, 8).is_empty(), "other number");
    assert!(index.lookup(0x90, 7).is_empty(), "other type");
}

#[test]
fn pitch_bend_matches_whatever_its_low_byte() {
    let mut settings = HashMap::new();
    settings.insert("strip:1:volume".to_string(), MidiBinding::new(0xE0, 0x12));
    let index = MidiBindingIndex::build(settings.iter());
    assert_eq!(index.lookup(0xE0, 0x00).len(), 1);
    assert_eq!(index.lookup(0xE0, 0x7F).len(), 1);
    assert!(index.lookup(0xE1, 0x00).is_empty());
}

#[test]
fn one_control_can_drive_several_targets_from_settings_and_session() {
    let mut settings = HashMap::new();
    settings.insert("param:tempo".to_string(), MidiBinding::new(0xB0, 1));
    settings.insert("bogus:thing".to_string(), MidiBinding::new(0xB0, 1));
    let mut session = BTreeMap::new();
    session.insert("track:t1:volume".to_string(), MidiBinding::new(0xB0, 1));
    session.insert("track:t2:volume".to_string(), MidiBinding::new(0xB0, 1));
    let index = MidiBindingIndex::build(settings.iter().chain(session.iter()));
    let keys: Vec<String> = index
        .lookup(0xB0, 1)
        .iter()
        .map(|(target, _)| target.key())
        .collect();
    assert_eq!(keys, ["param:tempo", "track:t1:volume", "track:t2:volume"]);
    assert_eq!(index.len(), 3, "the unknown key is skipped");
}

// --- Targets ---

#[test]
fn targets_parse_and_print_back() {
    for key in [
        "action:play",
        "action:jump_marker_3",
        "param:metronome_volume",
        "track:track_ab12:volume",
        "track:t:pan",
        "track:t:mute",
        "track:t:solo",
        "strip:8:volume",
        "strip:1:solo",
        "mixer:song_master:volume",
        "mixer:metronome:volume",
        "mixer:voice_guide:volume",
        "mixer:pads:volume",
        "bank:next",
        "bank:prev",
    ] {
        let target = MidiTarget::parse(key).unwrap_or_else(|| panic!("{key} parses"));
        assert_eq!(target.key(), key);
    }
    for key in [
        "action:",
        "track::volume",
        "track:t:gain",
        "strip:0:volume",
        "strip:x:volume",
        "mixer:pads:pan",
        "bank:up",
        "play",
    ] {
        assert_eq!(MidiTarget::parse(key), None, "{key} is rejected");
    }
}

#[test]
fn default_modes_follow_the_target() {
    let cc = MidiBinding::new(0xB0, 1);
    let note = MidiBinding::new(0x90, 1);
    let mute = MidiTarget::parse("track:t:mute").unwrap();
    let volume = MidiTarget::parse("strip:1:volume").unwrap();
    assert_eq!(cc.effective_mode(&mute), ControlMode::Toggle);
    assert_eq!(note.effective_mode(&mute), ControlMode::Toggle);
    assert_eq!(cc.effective_mode(&volume), ControlMode::Absolute);
    assert_eq!(
        MidiBinding::new(0xE0, 0).effective_mode(&volume),
        ControlMode::Absolute
    );
    assert_eq!(
        cc.effective_mode(&MidiTarget::parse("action:toggle_metronome").unwrap()),
        ControlMode::Toggle
    );
    assert_eq!(
        cc.effective_mode(&MidiTarget::parse("bank:next").unwrap()),
        ControlMode::Trigger
    );
    assert!(MidiTarget::parse("track:t:pan").unwrap().belongs_to_session());
    assert!(!volume.belongs_to_session());
}

// --- Value math ---

#[test]
fn normalized_values_cover_7_and_14_bits() {
    assert_eq!(normalized_value(0xB0, 7, 0), 0.0);
    assert_eq!(normalized_value(0xB0, 7, 127), 1.0);
    assert_eq!(normalized_value(0xE0, 0x00, 0x00), 0.0);
    assert_eq!(normalized_value(0xE0, 0x7F, 0x7F), 1.0);
    let centre = normalized_value(0xE0, 0x00, 0x40);
    assert!((centre - 8192.0 / 16383.0).abs() < 1e-12);
    assert_eq!(normalized_value(0x80, 60, 100), 0.0, "note off is a release");
    assert_eq!(normalized_value(0x90, 60, 0), 0.0);
    assert_eq!(normalized_value(0xC0, 5, 0), 1.0);
}

#[test]
fn scale_maps_range_and_invert() {
    let mut binding = MidiBinding::new(0xB0, 1);
    assert_eq!(binding.scale(0.5), 0.5);
    binding.min = 0.2;
    binding.max = 0.6;
    assert!((binding.scale(0.0) - 0.2).abs() < 1e-12);
    assert!((binding.scale(1.0) - 0.6).abs() < 1e-12);
    binding.invert = true;
    assert!((binding.scale(0.0) - 0.6).abs() < 1e-12);
    assert!((binding.scale(1.0) - 0.2).abs() < 1e-12);
    // unscale is the inverse inside the range and None outside.
    assert!((binding.unscale(0.5).unwrap() - 0.25).abs() < 1e-12);
    assert_eq!(binding.unscale(0.9), None);
}

#[test]
fn relative_encodings_decode_both_directions() {
    use ControlMode::*;
    assert_eq!(decode_relative(1, RelativeTwosComplement), 1);
    assert_eq!(decode_relative(127, RelativeTwosComplement), -1);
    assert_eq!(decode_relative(65, RelativeTwosComplement), -63);
    assert_eq!(decode_relative(65, RelativeBinaryOffset), 1);
    assert_eq!(decode_relative(63, RelativeBinaryOffset), -1);
    assert_eq!(decode_relative(64, RelativeBinaryOffset), 0);
    assert_eq!(decode_relative(3, RelativeSignMagnitude), 3);
    assert_eq!(decode_relative(65, RelativeSignMagnitude), -1);
    assert_eq!(decode_relative(10, Absolute), 0);
}

#[test]
fn soft_takeover_waits_until_the_control_reaches_the_value() {
    let mut takeover = SoftTakeover::default();
    // Target at 0.8, fader comes from below.
    assert!(!takeover.feed(0.1, 0.8));
    assert!(!takeover.feed(0.5, 0.8));
    assert!(takeover.feed(0.79, 0.8), "within threshold");
    assert!(takeover.feed(0.2, 0.8), "stays picked up afterwards");
}

#[test]
fn soft_takeover_catches_a_fast_swipe_that_skips_the_value() {
    let mut takeover = SoftTakeover::default();
    assert!(!takeover.feed(0.1, 0.5));
    assert!(takeover.feed(0.9, 0.5), "crossed between two messages");
}

#[test]
fn soft_takeover_release_needs_a_new_pickup() {
    let mut takeover = SoftTakeover::default();
    assert!(takeover.feed(0.5, 0.5));
    takeover.release();
    assert!(!takeover.is_picked_up());
    assert!(!takeover.feed(0.2, 0.7));
}

#[test]
fn buttons_toggle_hold_or_fire() {
    use ButtonEvent::*;
    use ControlMode::*;
    assert_eq!(ButtonState::decide(Toggle, 1.0, false), Set(true));
    assert_eq!(ButtonState::decide(Toggle, 1.0, true), Set(false));
    assert_eq!(ButtonState::decide(Toggle, 0.0, true), Ignore, "release");
    assert_eq!(ButtonState::decide(Momentary, 1.0, false), Set(true));
    assert_eq!(ButtonState::decide(Momentary, 0.0, true), Set(false));
    assert_eq!(ButtonState::decide(Trigger, 1.0, false), Fire);
    assert_eq!(ButtonState::decide(Trigger, 0.0, false), Ignore);
}

// --- Fader taper (must match packages/shared/src/faderScale.ts) ---

#[test]
fn fader_taper_matches_the_on_screen_fader() {
    use super::fader::{TRACK_MAX_DB, UNITY_POSITION};
    assert_eq!(position_to_gain(0.0, TRACK_MAX_DB), 0.0);
    assert!((position_to_gain(UNITY_POSITION, TRACK_MAX_DB) - 1.0).abs() < 1e-12);
    let top = position_to_gain(1.0, TRACK_MAX_DB);
    assert!((top - 10f64.powf(0.5)).abs() < 1e-9, "+10 dB");
    // -12 dB sits at u = 0.8 → position 0.6 (faderScale.test.ts).
    let minus12 = 10f64.powf(-12.0 / 20.0);
    assert!((gain_to_position(minus12, TRACK_MAX_DB) - 0.6).abs() < 1e-9);
    for position in [0.05, 0.2, 0.45, 0.6, 0.75, 0.9, 1.0] {
        let round = gain_to_position(position_to_gain(position, TRACK_MAX_DB), TRACK_MAX_DB);
        assert!((round - position).abs() < 1e-9, "{position} round trips");
    }
}

#[test]
fn pan_centre_is_the_middle_of_the_control() {
    assert_eq!(position_to_pan(0.5), 0.0);
    assert_eq!(position_to_pan(0.0), -1.0);
    assert_eq!(position_to_pan(1.0), 1.0);
    assert_eq!(pan_to_position(0.0), 0.5);
}

#[test]
fn soft_takeover_lets_go_when_something_else_moves_the_target() {
    let mut takeover = SoftTakeover::default();
    assert!(takeover.feed(0.5, 0.5));
    takeover.wrote(0.5);
    takeover.sync(0.5);
    assert!(takeover.is_picked_up(), "our own write keeps it");
    takeover.sync(0.9);
    assert!(!takeover.is_picked_up(), "the screen moved it");
}

// --- Scheduling ---

#[test]
fn debounce_fires_once_after_the_burst_goes_quiet() {
    use std::time::{Duration, Instant};
    let start = Instant::now();
    let ms = Duration::from_millis;
    let mut debounce = Debounce::new(ms(300));
    debounce.touch("t1", start);
    debounce.touch("t1", start + ms(200));
    debounce.touch("t2", start + ms(100));
    assert!(debounce.take_due(start + ms(400)).contains(&"t2"));
    assert!(debounce.take_due(start + ms(450)).is_empty(), "t1 was pushed back");
    assert_eq!(debounce.next_deadline(), Some(start + ms(500)));
    assert_eq!(debounce.take_due(start + ms(500)), ["t1"]);
    assert_eq!(debounce.next_deadline(), None);
}

#[test]
fn throttle_emits_leading_and_trailing_but_not_every_hit() {
    use std::time::{Duration, Instant};
    let start = Instant::now();
    let ms = Duration::from_millis;
    let mut throttle = Throttle::new(ms(33));
    assert!(throttle.hit(start), "leading");
    let mut emitted = 0;
    for step in 1..=30 {
        if throttle.hit(start + ms(step)) {
            emitted += 1;
        }
    }
    assert_eq!(emitted, 0, "30 messages in 30 ms do not emit again");
    assert!(!throttle.poll(start + ms(32)));
    assert!(throttle.poll(start + ms(33)), "trailing");
    assert!(!throttle.poll(start + ms(80)), "nothing pending");
}

// --- Banks ---

fn order(len: usize) -> Vec<String> {
    (1..=len).map(|index| format!("t{index}")).collect()
}

#[test]
fn strips_resolve_against_the_current_bank() {
    let tracks = order(19);
    let mut bank = Bank::default();
    assert_eq!(bank.track(&tracks, 1), Some("t1"));
    assert_eq!(bank.track(&tracks, 8), Some("t8"));
    assert_eq!(bank.track(&tracks, 9), None, "only 8 strips");
    assert_eq!(bank.track(&tracks, 0), None);
    assert!(bank.step(tracks.len(), 1));
    assert_eq!(bank.track(&tracks, 1), Some("t9"));
    assert!(bank.step(tracks.len(), 1));
    assert_eq!(bank.track(&tracks, 3), Some("t19"));
    assert_eq!(bank.track(&tracks, 4), None, "past the last track");
    assert_eq!(bank.tracks(&tracks).len(), 3);
}

#[test]
fn bank_steps_stop_at_both_ends() {
    let mut bank = Bank::default();
    assert!(!bank.step(19, -1), "already on the first bank");
    assert!(bank.step(19, 5));
    assert_eq!(bank.offset, 16, "jumps to the last bank, not past it");
    assert!(!bank.step(19, 1));
    assert!(!Bank::default().step(8, 1), "one bank only");
    assert!(!Bank::default().step(0, 1));
}

#[test]
fn bank_clamps_when_tracks_go_away() {
    let mut bank = Bank { offset: 16 };
    bank.clamp(10);
    assert_eq!(bank.offset, 8);
    bank.clamp(0);
    assert_eq!(bank.offset, 0);
}

// --- Feedback ---

#[test]
fn feedback_lights_buttons_on_the_channel_they_send_on() {
    let note = MidiBinding::new(0x92, 41);
    assert_eq!(feedback_message(&note, FeedbackValue::Switch(true)), Some([0x92, 41, 127]));
    assert_eq!(feedback_message(&note, FeedbackValue::Switch(false)), Some([0x92, 41, 0]));
    let cc = MidiBinding::new(0xB0, 48);
    assert_eq!(feedback_message(&cc, FeedbackValue::Switch(true)), Some([0xB0, 48, 127]));
    // A note cannot show a position, a pitch bend cannot show an LED.
    assert_eq!(feedback_message(&note, FeedbackValue::Position(0.5)), None);
    let bend = MidiBinding::new(0xE1, 0);
    assert_eq!(feedback_message(&bend, FeedbackValue::Switch(true)), None);
}

#[test]
fn feedback_moves_motor_faders_inside_the_binding_range() {
    let bend = MidiBinding::new(0xE0, 0);
    assert_eq!(feedback_message(&bend, FeedbackValue::Position(1.0)), Some([0xE0, 0x7F, 0x7F]));
    assert_eq!(feedback_message(&bend, FeedbackValue::Position(0.0)), Some([0xE0, 0, 0]));
    let mut cc = MidiBinding::new(0xB0, 7);
    cc.min = 0.5;
    assert_eq!(feedback_message(&cc, FeedbackValue::Position(0.75)), Some([0xB0, 7, 64]));
    assert_eq!(feedback_message(&cc, FeedbackValue::Position(0.2)), None, "outside the range");
    cc.mode = Some(ControlMode::RelativeTwosComplement);
    assert_eq!(feedback_message(&cc, FeedbackValue::Position(0.75)), None, "plain encoder");
}

// --- Scene targets (plan live-scenes, paso 05). ---

#[test]
fn scene_targets_round_trip_and_reject_bad_keys() {
    for key in ["scene:s-1:toggle", "scene:s-1:apply", "scene:s-1:restore", "scene_slot:3"] {
        let target = MidiTarget::parse(key).unwrap_or_else(|| panic!("{key} parses"));
        assert_eq!(target.key(), key);
        assert_eq!(MidiTarget::parse(&target.key()), Some(target));
    }
    for key in ["scene:", "scene::toggle", "scene:s-1", "scene:s-1:foo", "scene_slot:0", "scene_slot:x", "scene_slot:"] {
        assert_eq!(MidiTarget::parse(key), None, "{key} is rejected");
    }
}

#[test]
fn scene_toggles_are_switches_and_apply_restore_fire() {
    let kind = |key: &str| MidiTarget::parse(key).unwrap().value_kind();
    assert_eq!(kind("scene:s:toggle"), TargetValueKind::Switch);
    assert_eq!(kind("scene_slot:1"), TargetValueKind::Switch);
    assert_eq!(kind("scene:s:apply"), TargetValueKind::Trigger);
    assert_eq!(kind("scene:s:restore"), TargetValueKind::Trigger);
    assert!(MidiTarget::parse("scene:s:toggle").unwrap().toggles());
    assert!(!MidiTarget::parse("scene:s:apply").unwrap().toggles());
    assert!(MidiTarget::parse("scene:s:apply").unwrap().belongs_to_session());
}

#[test]
fn scene_slots_follow_the_editor_order() {
    let scenes = vec!["a".to_string(), "b".to_string()];
    let slot = |n: u16| MidiTarget::SceneSlot(n).scene_trigger(&scenes);
    assert_eq!(slot(1), Some(("a".to_string(), SceneMode::Toggle)));
    assert_eq!(slot(2), Some(("b".to_string(), SceneMode::Toggle)));
    assert_eq!(slot(3), None, "past the last scene does nothing");
    let by_id = MidiTarget::parse("scene:b:restore").unwrap();
    assert_eq!(by_id.scene_trigger(&scenes), Some(("b".to_string(), SceneMode::Restore)));
    let other = MidiTarget::parse("scene:gone:toggle").unwrap();
    assert_eq!(other.scene_trigger(&scenes), None, "a scene of another session");
    assert_eq!(MidiTarget::parse("action:play").unwrap().scene_trigger(&scenes), None);
}

#[test]
fn scene_leds_follow_the_engaged_scenes() {
    let scenes = vec!["a".to_string(), "b".to_string()];
    let engaged = vec!["b".to_string()];
    let led = |key: &str| MidiTarget::parse(key).unwrap().scene_led(&scenes, &engaged);
    assert_eq!(led("scene:b:toggle"), Some(true));
    assert_eq!(led("scene:a:toggle"), Some(false));
    assert_eq!(led("scene_slot:2"), Some(true));
    assert_eq!(led("scene_slot:1"), Some(false));
    assert_eq!(led("scene_slot:9"), Some(false));
    assert_eq!(led("scene:b:apply"), None);
}
