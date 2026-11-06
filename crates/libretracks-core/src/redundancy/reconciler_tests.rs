//! The reconciler against a simulated pair of machines: two audio clocks with
//! drift, different output latencies, a network with deterministic delay,
//! jitter and loss, and a fake backup engine that applies each action.
//! Simulated time advances in 1 ms steps; nothing sleeps.

use super::*;

const MS: u64 = 1_000_000;

/// Deterministic pseudo-random numbers (fixed seed per test).
struct Rng(u64);

impl Rng {
    fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

#[derive(Debug, Clone)]
struct Engine {
    playing: bool,
    position: f64,
    rate: f64,
    latency: f64,
    vamp: bool,
    pending: Option<PendingJump>,
}

impl Engine {
    fn new(rate: f64, latency: f64) -> Self {
        Self {
            playing: false,
            position: 0.0,
            rate,
            latency,
            vamp: false,
            pending: None,
        }
    }

    fn advance(&mut self, dt: f64) {
        if !self.playing {
            return;
        }
        let next = self.position + dt * self.rate;
        if let Some(jump) = self.pending.clone() {
            if let (Some(at), Some(target)) = (jump.execute_at_seconds, jump.target_seconds) {
                if self.position < at && next >= at {
                    self.position = target + (next - at);
                    self.pending = None;
                    return;
                }
            }
        }
        self.position = next;
    }

    fn audible(&self) -> f64 {
        if self.playing {
            self.position - self.latency
        } else {
            self.position
        }
    }
}

#[derive(Debug, Clone)]
enum Message {
    State {
        clock: AudioClockSample,
        song_id: Option<String>,
        vamp: bool,
        pending: Option<PendingJump>,
    },
    Intent(u64, MainIntent),
}

struct Sim {
    now: u64,
    a: Engine,
    b: Engine,
    rng: Rng,
    loss: f64,
    delay_ms: (f64, f64),
    /// Error of the clock estimator mapping A's instants onto B's base.
    estimator_error_ms: f64,
    queue: Vec<(u64, Message)>,
    seq: u64,
    main: Option<MainView>,
    last_applied: u64,
    last_correction: Option<u64>,
    playing_since: Option<u64>,
    main_lost: bool,
    manual_offset: f64,
    policy: Policy,
    silent: bool,
    regions: Vec<(&'static str, f64, f64)>,
    actions: Vec<(u64, f64, Action)>,
    next_state_at: u64,
}

impl Sim {
    fn new(seed: u64) -> Self {
        Self {
            now: 0,
            a: Engine::new(1.0, 0.010),
            b: Engine::new(1.0, 0.005),
            rng: Rng(seed),
            loss: 0.0,
            delay_ms: (1.0, 1.0),
            estimator_error_ms: 0.0,
            queue: Vec::new(),
            seq: 0,
            main: None,
            last_applied: 0,
            last_correction: None,
            playing_since: None,
            main_lost: false,
            manual_offset: 0.0,
            policy: Policy::default(),
            silent: false,
            regions: vec![("song-1", 0.0, 20_000.0)],
            actions: Vec::new(),
            next_state_at: 0,
        }
    }

    fn song_at(&self, position: f64) -> Option<String> {
        self.regions
            .iter()
            .find(|(_, start, end)| position >= *start && position < *end)
            .map(|(id, _, _)| id.to_string())
    }

    fn bounds_at(&self, position: f64) -> Option<(f64, f64)> {
        self.regions
            .iter()
            .find(|(_, start, end)| position >= *start && position < *end)
            .map(|(_, start, end)| (*start, *end))
    }

    fn send(&mut self, message: Message) {
        if self.silent || self.rng.next_f64() < self.loss {
            return;
        }
        let (low, high) = self.delay_ms;
        let delay = low + (high - low) * self.rng.next_f64();
        let deliver = self.now + (delay * MS as f64) as u64;
        self.queue.push((deliver, message));
    }

    fn publish_state(&mut self) {
        let error = (self.rng.next_f64() * 2.0 - 1.0) * self.estimator_error_ms;
        let sampled_at = (self.now as f64 + error * MS as f64).max(0.0) as u64;
        let message = Message::State {
            clock: AudioClockSample {
                position_seconds: self.a.position,
                sampled_at_ns: sampled_at,
                playing: self.a.playing,
                output_latency_seconds: self.a.latency,
            },
            song_id: self.song_at(self.a.position),
            vamp: self.a.vamp,
            pending: self.a.pending.clone(),
        };
        self.send(message);
    }

    fn intent(&mut self, intent: MainIntent) {
        self.seq += 1;
        let seq = self.seq;
        self.send(Message::Intent(seq, intent));
        self.publish_state();
    }

    // --- what the operator does on A ---

    fn a_play(&mut self) {
        self.a.playing = true;
        let from = self.a.position;
        self.intent(MainIntent::Play {
            from_seconds: from,
            at_ns: self.now,
        });
    }

    fn a_pause(&mut self) {
        self.a.playing = false;
        let at = self.a.position;
        self.intent(MainIntent::Pause { at_seconds: at });
    }

    fn a_seek(&mut self, to: f64) {
        self.a.position = to;
        self.intent(MainIntent::Seek {
            to_seconds: to,
            at_ns: self.now,
        });
    }

    fn a_vamp(&mut self, enabled: bool) {
        self.a.vamp = enabled;
        self.intent(MainIntent::SetVamp(enabled));
    }

    fn a_schedule_jump(&mut self, jump: PendingJump) {
        self.a.pending = Some(jump.clone());
        self.intent(MainIntent::ScheduleJump(jump));
    }

    // --- the backup ---

    fn local_view(&self) -> LocalView {
        LocalView {
            clock: AudioClockSample {
                position_seconds: self.b.position,
                sampled_at_ns: self.now,
                playing: self.b.playing,
                output_latency_seconds: self.b.latency,
            },
            song_id: self.song_at(self.b.position),
            vamp: self.b.vamp,
            pending_jump: self.b.pending.clone(),
            last_applied_intent_seq: self.last_applied,
            last_correction_at_ns: self.last_correction,
            playing_since_ns: self.playing_since,
            region_bounds: self.bounds_at(self.b.position),
            manual_offset_seconds: self.manual_offset,
            main_lost: self.main_lost,
        }
    }

    fn deliver(&mut self) {
        let now = self.now;
        let mut due: Vec<(u64, Message)> = Vec::new();
        self.queue.retain(|(at, message)| {
            if *at <= now {
                due.push((*at, message.clone()));
                false
            } else {
                true
            }
        });
        due.sort_by_key(|(at, _)| *at);
        for (_, message) in due {
            match message {
                Message::State {
                    clock,
                    song_id,
                    vamp,
                    pending,
                } => {
                    let last_intent = self.main.as_ref().and_then(|main| main.last_intent.clone());
                    self.main = Some(MainView {
                        clock,
                        song_id,
                        vamp,
                        pending_jump: pending,
                        last_intent,
                        received_at_ns: now,
                    });
                }
                Message::Intent(seq, intent) => {
                    if let Some(main) = &mut self.main {
                        if main.last_intent.as_ref().is_none_or(|(last, _)| seq > *last) {
                            main.last_intent = Some((seq, intent));
                        }
                        main.received_at_ns = now;
                    } else {
                        // An intent before any state: wait for the state.
                    }
                }
            }
        }
    }

    fn apply(&mut self, decision: Decision) {
        let position = self.b.position;
        match &decision.action {
            Action::None | Action::Freewheel(_) => {}
            Action::Play { from_seconds } => {
                self.b.playing = true;
                self.b.position = *from_seconds;
                self.playing_since = Some(self.now);
            }
            Action::Pause { at_seconds } => {
                self.b.playing = false;
                self.b.position = *at_seconds;
            }
            Action::Stop => {
                self.b.playing = false;
                self.b.position = 0.0;
            }
            Action::FadeOutStop { .. } => {}
            Action::SeekAbsolute { to_seconds } => {
                self.b.position = *to_seconds;
                if self.b.playing {
                    self.playing_since = Some(self.now);
                }
            }
            Action::Nudge { delta_seconds } => {
                self.b.position += delta_seconds;
                self.last_correction = Some(self.now);
            }
            Action::ScheduleJump(jump) => self.b.pending = Some(jump.clone()),
            Action::CancelJump => self.b.pending = None,
            Action::SetVamp(enabled) => self.b.vamp = *enabled,
        }
        if let Some(seq) = decision.applied_intent {
            self.last_applied = seq;
        }
        // The lifecycle (step 07), as far as these tests need it.
        match decision.action {
            Action::Freewheel(FreewheelReason::Stale) => self.main_lost = true,
            Action::Freewheel(_) => {}
            _ => self.main_lost = false,
        }
        if !matches!(decision.action, Action::None | Action::Freewheel(_)) {
            self.actions.push((self.now, position, decision.action));
        }
    }

    fn desfase(&self) -> f64 {
        self.a.audible() - self.b.audible() - self.manual_offset
    }

    fn step(&mut self) {
        self.now += MS;
        self.a.advance(0.001);
        self.b.advance(0.001);
        if self.now >= self.next_state_at {
            self.publish_state();
            self.next_state_at = self.now + 50 * MS;
        }
        self.deliver();
        if self.now % (20 * MS) == 0 {
            let local = self.local_view();
            let decision = reconcile(self.now, self.main.as_ref(), &local, &self.policy);
            self.apply(decision);
        }
    }

    fn run_ms(&mut self, ms: u64) {
        for _ in 0..ms {
            self.step();
        }
    }

    /// Both playing from the same place, already in step.
    fn start_in_step(&mut self, at: f64) {
        self.a.position = at;
        self.a.playing = true;
        self.b.position = at + (self.b.latency - self.a.latency);
        self.b.playing = true;
        self.publish_state();
        self.run_ms(5);
    }

    fn nudges(&self) -> Vec<u64> {
        self.actions
            .iter()
            .filter(|(_, _, action)| action.is_correction())
            .map(|(at, _, _)| *at)
            .collect()
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

#[test]
fn drift_of_80_ppm_for_an_hour_stays_within_threshold() {
    let mut sim = Sim::new(7);
    sim.a.rate = 1.0 + 80e-6;
    sim.delay_ms = (1.0, 5.0);
    sim.estimator_error_ms = 0.3;
    sim.start_in_step(0.0);

    let mut samples = Vec::with_capacity(360_000);
    for _ in 0..(60 * 60 * 100) {
        sim.run_ms(10);
        samples.push(sim.desfase().abs() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    let nudges = sim.nudges();
    let min_gap = nudges
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .min()
        .unwrap_or(u64::MAX);
    eprintln!(
        "[reconciler drift] p50={:.3} ms p95={:.3} ms p99={:.3} ms max={:.3} ms corrections={} min_gap={:.1} s",
        percentile(&samples, 0.50),
        percentile(&samples, 0.95),
        percentile(&samples, 0.99),
        samples[samples.len() - 1],
        nudges.len(),
        min_gap as f64 / 1e9
    );
    assert!(percentile(&samples, 0.99) <= 5.0 + 1.0);
    assert!(min_gap >= 2_000 * MS, "corrections too close: {min_gap}");
    assert!(!nudges.is_empty(), "80 ppm must need corrections");
}

#[test]
fn a_play_that_arrives_8_ms_late_starts_further_on() {
    let mut sim = Sim::new(1);
    sim.delay_ms = (8.0, 8.0);
    sim.a.position = 10.0;
    sim.b.position = 10.0;
    sim.publish_state();
    sim.run_ms(100);
    sim.a_play();
    sim.run_ms(100);
    let offset = sim.desfase().abs();
    eprintln!("[reconciler late play] offset after 100 ms = {:.3} ms", offset * 1000.0);
    assert!(offset <= 0.001, "{offset}");
}

fn jump_at(execute_at: f64, target: f64) -> PendingJump {
    PendingJump {
        target: "marker:chorus".into(),
        trigger: "next_bar".into(),
        bars: None,
        transition: Some("instant".into()),
        duration_seconds: None,
        execute_at_seconds: Some(execute_at),
        target_seconds: Some(target),
    }
}

#[test]
fn a_scheduled_jump_lands_together() {
    let mut sim = Sim::new(3);
    sim.delay_ms = (1.0, 3.0);
    sim.start_in_step(0.0);
    sim.run_ms(1000);
    sim.a_schedule_jump(jump_at(2.0, 30.0));
    sim.run_ms(2000);
    assert!(sim.a.position > 30.0 && sim.b.position > 30.0, "both jumped");
    let offset = sim.desfase().abs();
    eprintln!("[reconciler jump] offset after the jump = {:.3} ms", offset * 1000.0);
    assert!(offset <= 0.001, "{offset}");
}

#[test]
fn no_nudge_inside_the_guard_window_of_a_jump() {
    let mut sim = Sim::new(4);
    sim.start_in_step(0.0);
    sim.run_ms(1000);
    sim.a_schedule_jump(jump_at(2.0, 30.0));
    sim.run_ms(880);
    // B drifts 6 ms behind right as it enters the window before the jump.
    sim.b.position -= 0.006;
    sim.run_ms(400);
    let window = sim.policy.guard_window_seconds;
    let in_window = sim
        .actions
        .iter()
        .filter(|(_, position, action)| {
            action.is_correction() && (*position - 2.0).abs() < window
        })
        .count();
    assert_eq!(in_window, 0, "{:?}", sim.actions);
}

#[test]
fn a_pause_the_main_decided_alone_reaches_the_backup_within_100_ms() {
    let mut sim = Sim::new(5);
    sim.delay_ms = (1.0, 5.0);
    sim.start_in_step(0.0);
    sim.run_ms(2000);
    // Pause at song end: no intent, only the state says so.
    sim.a.playing = false;
    let mut waited = 0;
    while sim.b.playing && waited < 1000 {
        sim.run_ms(1);
        waited += 1;
    }
    eprintln!("[reconciler alone] pause followed after {waited} ms");
    assert!(waited <= 100, "{waited} ms");
    assert!((sim.b.position - sim.a.position).abs() < 0.001);
}

#[test]
fn a_jump_the_main_decided_alone_reaches_the_backup_within_100_ms() {
    let mut sim = Sim::new(6);
    sim.delay_ms = (1.0, 5.0);
    sim.regions = vec![("song-1", 0.0, 40.0), ("song-2", 40.0, 90.0)];
    sim.start_in_step(10.0);
    sim.run_ms(1000);
    // An automation cue moves A into the next song with no intent.
    sim.a.position = 50.0;
    let mut waited = 0;
    while sim.desfase().abs() > 0.001 && waited < 1000 {
        sim.run_ms(1);
        waited += 1;
    }
    eprintln!("[reconciler alone] jump followed after {waited} ms");
    assert!(waited <= 100, "{waited} ms");
}

#[derive(Debug, Clone, Copy)]
enum Transition {
    Play,
    Pause,
    Seek,
    Vamp,
    SongChange,
}

fn converges_with_loss(transition: Transition, seed: u64) {
    let mut sim = Sim::new(seed);
    sim.loss = 0.30;
    sim.delay_ms = (1.0, 5.0);
    sim.regions = vec![("song-1", 0.0, 40.0), ("song-2", 40.0, 90.0)];
    match transition {
        Transition::Play => {
            sim.a.position = 5.0;
            sim.b.position = 5.0;
            sim.run_ms(200);
            sim.a_play();
        }
        Transition::Pause => {
            sim.start_in_step(5.0);
            sim.run_ms(500);
            sim.a_pause();
        }
        Transition::Seek => {
            sim.start_in_step(5.0);
            sim.run_ms(500);
            sim.a_seek(20.0);
        }
        Transition::Vamp => {
            sim.start_in_step(5.0);
            sim.run_ms(500);
            sim.a_vamp(true);
        }
        Transition::SongChange => {
            sim.start_in_step(5.0);
            sim.run_ms(500);
            sim.a_seek(45.0);
        }
    }
    sim.run_ms(1500);
    assert_eq!(sim.b.playing, sim.a.playing, "{transition:?} seed {seed}");
    assert_eq!(sim.b.vamp, sim.a.vamp, "{transition:?} seed {seed}");
    assert_eq!(
        sim.song_at(sim.b.position),
        sim.song_at(sim.a.position),
        "{transition:?} seed {seed}"
    );
    assert!(
        sim.desfase().abs() <= 0.006,
        "{transition:?} seed {seed}: {:.3} ms",
        sim.desfase() * 1000.0
    );
}

#[test]
fn with_30_percent_loss_the_backup_ends_in_the_main_state() {
    for transition in [
        Transition::Play,
        Transition::Pause,
        Transition::Seek,
        Transition::Vamp,
        Transition::SongChange,
    ] {
        for seed in 1..=12 {
            converges_with_loss(transition, seed);
        }
    }
}

fn view(seq: u64, intent: MainIntent, vamp_local: bool) -> (MainView, LocalView) {
    let clock = AudioClockSample {
        position_seconds: 1.0,
        sampled_at_ns: 0,
        playing: true,
        output_latency_seconds: 0.0,
    };
    let main = MainView {
        clock,
        song_id: None,
        vamp: true,
        pending_jump: None,
        last_intent: Some((seq, intent)),
        received_at_ns: 0,
    };
    let local = LocalView {
        clock,
        song_id: None,
        vamp: vamp_local,
        pending_jump: None,
        last_applied_intent_seq: 5,
        last_correction_at_ns: None,
        playing_since_ns: None,
        region_bounds: None,
        manual_offset_seconds: 0.0,
        main_lost: false,
    };
    (main, local)
}

#[test]
fn a_repeated_or_old_intent_does_nothing() {
    let policy = Policy::default();
    for seq in [4, 5] {
        let (main, local) = view(seq, MainIntent::SetVamp(true), true);
        let decision = reconcile(0, Some(&main), &local, &policy);
        assert_eq!(decision.applied_intent, None, "seq {seq}");
        assert_eq!(decision.action, Action::None, "seq {seq}");
    }
    // A new vamp intent that matches the backup already: no flip.
    let (main, local) = view(6, MainIntent::SetVamp(true), true);
    let decision = reconcile(0, Some(&main), &local, &policy);
    assert_eq!(decision.action, Action::None);
    assert_eq!(decision.applied_intent, Some(6));
    // And a new one that differs is applied once.
    let (main, local) = view(6, MainIntent::SetVamp(true), false);
    assert_eq!(
        reconcile(0, Some(&main), &local, &policy).action,
        Action::SetVamp(true)
    );
}

#[test]
fn when_the_main_goes_quiet_the_backup_freewheels_and_keeps_playing() {
    let mut sim = Sim::new(8);
    sim.start_in_step(0.0);
    sim.run_ms(5000);
    let actions_before = sim.actions.len();
    sim.silent = true;
    let position_before = sim.b.position;
    sim.run_ms(1000 + 40);
    let local = sim.local_view();
    assert_eq!(
        reconcile(sim.now, sim.main.as_ref(), &local, &sim.policy).action,
        Action::Freewheel(FreewheelReason::Stale)
    );
    sim.run_ms(30_000);
    assert!(sim.b.playing, "never stops for lack of data");
    assert!(sim.b.position > position_before + 30.0);
    assert_eq!(sim.actions.len(), actions_before, "{:?}", &sim.actions[actions_before..]);
    assert_eq!(
        reconcile(0, None, &local, &sim.policy).action,
        Action::Freewheel(FreewheelReason::NoData)
    );
}

#[test]
fn a_main_that_comes_back_in_the_same_state_takes_one_action() {
    let mut sim = Sim::new(9);
    sim.start_in_step(0.0);
    sim.run_ms(2000);
    sim.silent = true;
    sim.run_ms(10_000);
    assert!(sim.main_lost);
    // While lost, A moved on by a second (still playing).
    sim.a.position += 1.0;
    sim.silent = false;
    let before = sim.actions.len();
    sim.run_ms(1000);
    let after: Vec<_> = sim.actions[before..].to_vec();
    assert_eq!(after.len(), 1, "{after:?}");
    assert!(matches!(after[0].2, Action::SeekAbsolute { .. }));
    assert!(sim.desfase().abs() <= 0.001);
}

#[test]
fn a_main_that_comes_back_stopped_is_left_to_the_lifecycle() {
    let mut sim = Sim::new(10);
    sim.start_in_step(0.0);
    sim.run_ms(2000);
    sim.silent = true;
    sim.run_ms(10_000);
    sim.a.playing = false;
    sim.silent = false;
    sim.run_ms(200);
    let local = sim.local_view();
    assert_eq!(
        reconcile(sim.now, sim.main.as_ref(), &local, &sim.policy).action,
        Action::Freewheel(FreewheelReason::Diverged)
    );
    assert!(sim.b.playing, "not applied on its own");
}
