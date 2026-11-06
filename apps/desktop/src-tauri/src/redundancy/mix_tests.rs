//! Redundancy step 09: the mirror mix, on real sessions (no-link stubs).

use libretracks_core::redundancy::reconciler::Policy;
use libretracks_core::session_fingerprint::FingerprintDiff;
use libretracks_link::redundancy::{MixControl, RedundancyMessage};

use super::*;
use crate::audio::engine::AudioController;
use crate::redundancy::follower::{tick, FollowTarget, FollowerCore, FollowerPhase, LocalInputs};
use crate::state::DesktopSession;

fn session(name: &str) -> DesktopSession {
    crate::state::tests::session_with_song_dir(
        name,
        crate::state::tests::demo_song_with_region_changes_and_sections(),
    )
}

fn song(session: &DesktopSession) -> Song {
    session.engine.song().cloned().unwrap()
}

/// The main's mix moved away from the default on every control.
fn main_with_a_mix(audio: &AudioController) -> (DesktopSession, AppSettings) {
    let mut main = session("redundancy-mix-main");
    let track = song(&main).tracks[0].id.clone();
    main.update_track(&track, None, Some(0.42), Some(-0.3), Some(true), Some(true), None, audio)
        .unwrap();
    main.update_song_region_master_gain("region_1", 0.61, audio)
        .unwrap();
    let mut settings = AppSettings::default();
    settings.metronome_enabled = !settings.metronome_enabled;
    settings.metronome_volume = 0.33;
    settings.voice_guide_enabled = !settings.voice_guide_enabled;
    settings.voice_guide_volume = 1.7;
    (main, settings)
}

fn apply_full(backup: &mut DesktopSession, settings: &mut AppSettings, audio: &AudioController, mix: &MixSnapshot) {
    for control in mix.controls() {
        apply_to_session(backup, audio, &control, true).unwrap();
        apply_to_settings(settings, &control);
    }
}

#[test]
fn every_mirrored_control_lands_at_the_exact_value() {
    let audio = AudioController::default();
    let (main, main_settings) = main_with_a_mix(&audio);
    let mut backup = session("redundancy-mix-backup");
    let mut backup_settings = AppSettings::default();
    apply_full(
        &mut backup,
        &mut backup_settings,
        &audio,
        &MixSnapshot::from_song(&song(&main), &main_settings),
    );

    let (theirs, ours) = (song(&main), song(&backup));
    let track = &ours.tracks[0];
    assert_eq!(track.volume, 0.42);
    assert_eq!(track.pan, -0.3);
    assert!(track.muted);
    assert!(track.solo);
    assert_eq!(theirs.tracks[0].volume, track.volume);
    let master = |song: &Song| {
        song.regions
            .iter()
            .find(|region| region.id == "region_1")
            .unwrap()
            .master
            .gain
    };
    assert_eq!(master(&ours), 0.61);
    assert_eq!(backup_settings.metronome_enabled, main_settings.metronome_enabled);
    assert_eq!(backup_settings.metronome_volume, 0.33);
    assert_eq!(backup_settings.voice_guide_enabled, main_settings.voice_guide_enabled);
    assert_eq!(backup_settings.voice_guide_volume, 1.7);
}

#[test]
fn a_dragged_fader_is_coalesced_and_the_last_value_arrives() {
    let mut coalescer = MixCoalescer::default();
    let mut sent = Vec::new();
    let mut last = 0.0;
    for step in 0..100u64 {
        let now = step * 10_000_000; // 100 changes in one second
        last = step as f64 / 100.0;
        if let Some(control) = coalescer.push(
            MixControl::Track {
                track_id: "t".into(),
                volume: Some(last),
                pan: None,
                muted: None,
                solo: None,
            },
            now,
        ) {
            sent.push(control);
        }
        sent.extend(coalescer.flush(now));
    }
    // After the drag, the window passes and the held value goes out.
    sent.extend(coalescer.flush(1_100_000_000));
    assert!(sent.len() <= 34, "{} messages", sent.len());
    let Some(MixControl::Track { volume, .. }) = sent.last() else {
        panic!("no message");
    };
    assert_eq!(*volume, Some(last));
}

#[test]
fn partial_changes_of_one_track_are_folded_not_lost() {
    let mut coalescer = MixCoalescer::default();
    let track = |volume: Option<f64>, muted: Option<bool>| MixControl::Track {
        track_id: "t".into(),
        volume,
        pan: None,
        muted,
        solo: None,
    };
    assert!(coalescer.push(track(Some(0.5), None), 0).is_some());
    assert!(coalescer.push(track(Some(0.6), None), 5_000_000).is_none());
    assert!(coalescer.push(track(None, Some(true)), 10_000_000).is_none());
    assert_eq!(
        coalescer.flush(40_000_000),
        vec![track(Some(0.6), Some(true))]
    );
}

#[test]
fn after_the_snapshot_the_mix_fingerprints_match() {
    let audio = AudioController::default();
    let (main, settings) = main_with_a_mix(&audio);
    let mut backup = session("redundancy-mix-fp");
    let mixes = |session: &DesktopSession| -> Vec<String> {
        let source = session.fingerprint_source().unwrap();
        crate::redundancy::fingerprint::compute(&source, &settings)
            .songs
            .into_iter()
            .map(|song| song.mix)
            .collect()
    };
    assert_ne!(mixes(&main), mixes(&backup), "they start different");
    let mut backup_settings = settings.clone();
    apply_full(
        &mut backup,
        &mut backup_settings,
        &audio,
        &MixSnapshot::from_song(&song(&main), &settings),
    );
    assert_eq!(mixes(&main), mixes(&backup));
}

#[test]
fn a_local_mix_change_on_the_backup_is_a_divergence_until_the_next_snapshot() {
    let audio = AudioController::default();
    let (main, settings) = main_with_a_mix(&audio);
    let main_mix = MixSnapshot::from_song(&song(&main), &settings);
    let mut backup = session("redundancy-mix-diverge");
    let mut backup_settings = settings.clone();
    apply_full(&mut backup, &mut backup_settings, &audio, &main_mix);
    assert!(MixSnapshot::from_song(&song(&backup), &backup_settings).matches(&main_mix));

    // The technician touches the backup.
    let track = song(&backup).tracks[0].id.clone();
    backup
        .update_track(&track, None, Some(0.9), None, None, None, None, &audio)
        .unwrap();
    assert!(!MixSnapshot::from_song(&song(&backup), &backup_settings).matches(&main_mix));

    // The main's next whole mix puts it back.
    apply_full(&mut backup, &mut backup_settings, &audio, &main_mix);
    assert!(MixSnapshot::from_song(&song(&backup), &backup_settings).matches(&main_mix));
}

#[derive(Default)]
struct CountingTarget(u32);

impl FollowTarget for CountingTarget {
    fn apply(&mut self, _action: &libretracks_core::redundancy::reconciler::Action, _vamp: Option<(String, Option<u32>)>) -> Result<(), String> {
        self.0 += 1;
        Ok(())
    }
}

#[test]
fn moving_a_marker_on_the_main_stops_the_backup_from_following() {
    let audio = AudioController::default();
    let settings = AppSettings::default();
    let mut main = session("redundancy-mix-marker-main");
    let backup = session("redundancy-mix-marker-backup");
    // Move the first marker 10 ms on the main.
    let mut moved = song(&main);
    moved.section_markers[0].start_seconds += 0.010;
    main.engine.load_song(moved).unwrap();

    let fingerprint = |session: &DesktopSession| {
        crate::redundancy::fingerprint::compute(&session.fingerprint_source().unwrap(), &settings)
    };
    let mut core = FollowerCore::new(Policy::default(), 0.0);
    core.set_own_fingerprint(fingerprint(&backup));
    core.on_message(
        RedundancyMessage::Fingerprint {
            version: 1,
            fingerprint: serde_json::to_string(&fingerprint(&main)).unwrap(),
        },
        0,
        Some(0.0),
        None,
    );
    let mut target = CountingTarget::default();
    let local = LocalInputs {
        clock: Some(libretracks_core::audio_clock::AudioClockSample {
            position_seconds: 0.0,
            sampled_at_ns: 0,
            playing: false,
            output_latency_seconds: 0.0,
        }),
        vamp: false,
        pending_jump: None,
    };
    for step in 0..20 {
        tick(&mut core, &mut target, step * 20_000_000, &local, None);
    }
    assert_eq!(core.phase(), FollowerPhase::SessionMismatch);
    let title = song(&backup)
        .regions
        .iter()
        .find(|region| {
            region.start_seconds <= song(&backup).section_markers[0].start_seconds
                && song(&backup).section_markers[0].start_seconds < region.end_seconds
        })
        .unwrap()
        .name
        .clone();
    assert!(
        core.diffs().contains(&FingerprintDiff::TimelineDiffers { title }),
        "{:?}",
        core.diffs()
    );
    assert_eq!(target.0, 0, "no transport while the sessions differ");
    let _ = audio;
}

#[test]
fn mix_messages_never_touch_the_transport() {
    let audio = AudioController::default();
    let mut backup = session("redundancy-mix-transport");
    backup.play(&audio).unwrap();
    let mut intents = backup.subscribe_intents();
    let before = backup.snapshot();
    let track = song(&backup).tracks[0].id.clone();
    for step in 0..50 {
        let full = step % 2 == 0;
        let control = if step % 3 == 0 {
            MixControl::SongMaster {
                region_id: "region_1".into(),
                gain: 0.5 + step as f64 / 100.0,
            }
        } else {
            MixControl::Track {
                track_id: track.clone(),
                volume: Some(0.3 + step as f64 / 100.0),
                pan: Some(0.1),
                muted: Some(false),
                solo: Some(false),
            }
        };
        apply_to_session(&mut backup, &audio, &control, full).unwrap();
    }
    let after = backup.snapshot();
    assert_eq!(after.playback_state, before.playback_state);
    assert_eq!(after.playback_state, "playing");
    assert!(intents.try_recv().is_err(), "no transport intent at all");
}
