use super::*;

const MS: u64 = 1_000_000;
const S: u64 = 1_000_000_000;

fn healthy(now_ns: u64, offset: Option<f64>) -> BackupObservation {
    BackupObservation {
        now_ns,
        connected: true,
        main_alive: true,
        main_audio_ok: true,
        main_fallback_active: false,
        session: SessionCheck::Same,
        offset_seconds: offset,
        resynced: false,
        main_matches: Some(true),
    }
}

fn following() -> BackupLifecycle {
    let mut machine = BackupLifecycle::new(LifecyclePolicy::default());
    machine.enable();
    machine.observe(&healthy(0, None));
    assert_eq!(machine.state(), BackupState::Following);
    machine
}

/// Feed in-step observations every 10 ms from `from` to `to` (ns).
fn in_step(machine: &mut BackupLifecycle, from: u64, to: u64) {
    let mut now = from;
    while now <= to {
        machine.observe(&healthy(now, Some(0.001)));
        now += 10 * MS;
    }
}

#[test]
fn pairing_checking_and_mismatch() {
    let mut machine = BackupLifecycle::new(LifecyclePolicy::default());
    assert_eq!(machine.state(), BackupState::Disabled);
    machine.observe(&healthy(0, None));
    assert_eq!(machine.state(), BackupState::Disabled, "nothing until enabled");
    machine.enable();
    assert_eq!(machine.state(), BackupState::Pairing);
    let mut obs = healthy(0, None);
    obs.session = SessionCheck::Unknown;
    machine.observe(&obs);
    assert_eq!(machine.state(), BackupState::CheckingSession);
    obs.session = SessionCheck::Different;
    machine.observe(&obs);
    assert_eq!(machine.state(), BackupState::SessionMismatch);
    obs.session = SessionCheck::Same;
    machine.observe(&obs);
    assert_eq!(machine.state(), BackupState::Following);
    obs.connected = false;
    let mut lost_link = BackupLifecycle::new(LifecyclePolicy::default());
    lost_link.enable();
    lost_link.observe(&obs);
    assert_eq!(lost_link.state(), BackupState::Pairing);
}

#[test]
fn arms_after_three_seconds_in_step_not_before() {
    let mut machine = following();
    in_step(&mut machine, S, S + 2_990 * MS);
    assert_eq!(machine.state(), BackupState::Following, "2.99 s does not arm");
    machine.observe(&healthy(S + 3_010 * MS, Some(0.001)));
    assert_eq!(machine.state(), BackupState::Armed, "3.01 s does");
}

#[test]
fn an_offset_spike_restarts_the_arming_count() {
    let mut machine = following();
    in_step(&mut machine, S, S + 2_000 * MS);
    machine.observe(&healthy(S + 2_010 * MS, Some(0.008)));
    in_step(&mut machine, S + 2_020 * MS, S + 4_000 * MS);
    assert_eq!(machine.state(), BackupState::Following);
}

#[test]
fn disarms_after_a_second_out_of_step_or_on_a_resync() {
    let mut machine = following();
    in_step(&mut machine, S, 5 * S);
    assert_eq!(machine.state(), BackupState::Armed);
    machine.observe(&healthy(5 * S + 10 * MS, Some(0.010)));
    machine.observe(&healthy(5 * S + 990 * MS, Some(0.010)));
    assert_eq!(machine.state(), BackupState::Armed, "under a second");
    machine.observe(&healthy(6 * S + 30 * MS, Some(0.010)));
    assert_eq!(machine.state(), BackupState::Following);

    in_step(&mut machine, 7 * S, 11 * S);
    assert_eq!(machine.state(), BackupState::Armed);
    let mut obs = healthy(11 * S + 10 * MS, Some(0.0));
    obs.resynced = true;
    machine.observe(&obs);
    assert_eq!(machine.state(), BackupState::Following);
}

#[test]
fn a_silent_main_is_lost_and_unlocks_local_inputs() {
    let mut machine = following();
    assert!(machine.locks_local_inputs());
    let mut obs = healthy(2 * S, Some(0.0));
    obs.main_alive = false;
    let transition = machine.observe(&obs).unwrap();
    assert_eq!(transition.to, BackupState::MainLost { since_ns: 2 * S });
    assert!(!machine.locks_local_inputs(), "R6");
    assert!(!machine.applies_actions());
}

#[test]
fn main_lost_stays_for_an_hour_without_becoming_standalone() {
    let mut machine = following();
    let mut obs = healthy(S, None);
    obs.main_alive = false;
    machine.observe(&obs);
    let mut now = S;
    while now < 3_601 * S {
        obs.now_ns = now;
        assert_eq!(machine.observe(&obs), None);
        now += 100 * MS;
    }
    assert!(matches!(machine.state(), BackupState::MainLost { .. }), "D1");
    assert_eq!(machine.take_command().unwrap().to, BackupState::Standalone);
    // Standalone follows nobody, even a main that comes back.
    machine.observe(&healthy(3_602 * S, Some(0.0)));
    assert_eq!(machine.state(), BackupState::Standalone);
}

#[test]
fn a_main_without_audio_for_600_ms_is_lost_400_ms_is_not() {
    for (unhealthy_ms, lost) in [(400, false), (600, true)] {
        let mut machine = following();
        let mut now = S;
        let end = S + unhealthy_ms * MS;
        while now <= end {
            let mut obs = healthy(now, Some(0.0));
            obs.main_fallback_active = true;
            obs.main_audio_ok = false;
            machine.observe(&obs);
            now += 10 * MS;
        }
        assert_eq!(
            matches!(machine.state(), BackupState::MainLost { .. }),
            lost,
            "{unhealthy_ms} ms"
        );
    }
}

#[test]
fn back_in_the_same_state_without_local_orders_follows_again() {
    let mut machine = following();
    let mut obs = healthy(S, None);
    obs.main_alive = false;
    machine.observe(&obs);
    // Back, but not yet known where it is: wait.
    let mut back = healthy(10 * S, None);
    back.main_matches = None;
    assert_eq!(machine.observe(&back), None);
    machine.observe(&healthy(10 * S + 20 * MS, Some(0.0)));
    assert_eq!(machine.state(), BackupState::Following);
}

#[test]
fn a_local_order_while_lost_leads_to_diverged() {
    let mut machine = following();
    let mut obs = healthy(S, None);
    obs.main_alive = false;
    machine.observe(&obs);
    machine.local_order();
    machine.observe(&healthy(10 * S, Some(0.0)));
    assert_eq!(machine.state(), BackupState::Diverged);
    assert!(!machine.locks_local_inputs());
    // A local order while following means nothing (it was refused anyway).
    let mut other = following();
    other.local_order();
    let mut obs = healthy(S, None);
    obs.main_alive = false;
    other.observe(&obs);
    other.observe(&healthy(10 * S, Some(0.0)));
    assert_eq!(other.state(), BackupState::Following);
}

#[test]
fn back_in_another_state_is_diverged_and_the_user_chooses() {
    let mut machine = following();
    let mut obs = healthy(S, None);
    obs.main_alive = false;
    machine.observe(&obs);
    let mut back = healthy(10 * S, None);
    back.main_matches = Some(false);
    machine.observe(&back);
    assert_eq!(machine.state(), BackupState::Diverged);
    // Diverged does not move by itself.
    machine.observe(&healthy(11 * S, Some(0.0)));
    assert_eq!(machine.state(), BackupState::Diverged);
    assert_eq!(
        machine.follow_again().unwrap().to,
        BackupState::CheckingSession
    );
}

#[test]
fn the_main_sees_its_backup_come_arm_and_go() {
    let mut main = MainLifecycle::default();
    assert_eq!(main.state(), MainState::NoBackup);
    assert_eq!(main.observe(false, false, None), None);
    main.observe(true, true, Some(ReportedPhase::CheckingSession));
    assert_eq!(main.state(), MainState::BackupConnected);
    main.observe(true, true, Some(ReportedPhase::SessionMismatch));
    assert_eq!(main.state(), MainState::BackupMismatch);
    main.observe(true, true, Some(ReportedPhase::Armed));
    assert_eq!(main.state(), MainState::BackupArmed);
    main.observe(true, false, Some(ReportedPhase::Armed));
    assert_eq!(main.state(), MainState::BackupLost, "heartbeats stopped");
    main.observe(true, true, Some(ReportedPhase::Following));
    assert_eq!(main.state(), MainState::BackupConnected);
    main.observe(false, false, None);
    assert_eq!(main.state(), MainState::BackupLost);
    main.reset();
    assert_eq!(main.state(), MainState::NoBackup);
}

#[test]
fn a_role_offer_waits_for_the_user() {
    let mut main = MainLifecycle::default();
    main.offer_role_change(RoleOffer {
        new_main_name: "PC B".into(),
        new_main_address: Some("10.0.0.2:3040".into()),
    });
    main.observe(true, true, Some(ReportedPhase::Standalone));
    assert!(main.pending_offer().is_some(), "not applied alone");
    let offer = main.accept_offer().unwrap();
    assert_eq!(offer.new_main_name, "PC B");
    assert!(main.pending_offer().is_none());
}

#[test]
fn status_events_are_limited_to_four_a_second() {
    let mut throttle = StatusThrottle::four_hz();
    let mut emitted = 0;
    let mut now = 0;
    while now < 10 * S {
        if throttle.should_emit(now, false) {
            emitted += 1;
        }
        now += 20 * MS;
    }
    assert!(emitted <= 40, "{emitted}");
    assert!(emitted >= 39, "{emitted}");
    assert!(throttle.should_emit(now, true), "a state change always goes out");
}

#[test]
fn startup_after_an_unclean_exit_keeps_the_pilot_tone_off() {
    assert_eq!(
        startup_plan(true, true, true),
        StartupPlan {
            resume_main: true,
            pilot_tone_armed: false,
            warn_unclean_exit: true
        }
    );
    assert_eq!(
        startup_plan(true, false, true),
        StartupPlan {
            resume_main: true,
            pilot_tone_armed: true,
            warn_unclean_exit: false
        }
    );
    assert!(!startup_plan(true, false, false).pilot_tone_armed);
    assert!(!startup_plan(false, true, true).resume_main);
}
