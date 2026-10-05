//! The clock of a remote video receiver (plan `video-mobile`, paso 12, fase
//! 2): another machine that already has the videos plays them on its own
//! projector, and only the transport clock travels over the network.
//!
//! This is the pure core, testable with simulated clocks: the message
//! protocol, the offset between the sender's and the receiver's monotonic
//! clocks, and the clock the receiver's sync runtime reads. The WebSocket
//! transport, the discovery and the UI build on it and are not here yet.
//!
//! Times are microseconds of each machine's own monotonic clock.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

/// Bumped on any incompatible change to [`RemoteVideoMessage`].
pub const PROTOCOL_VERSION: u32 = 1;

/// One sample of the sender's transport, 20 times a second.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockSample {
    /// The sender runtime's discontinuity counter: a new one is a seek.
    pub generation: u64,
    /// Transport position, seconds, at `sender_micros`.
    pub position: f64,
    /// Playback rate (1.0 normally).
    pub rate: f64,
    pub running: bool,
    /// The sender's monotonic clock when `position` was true.
    pub sender_micros: i64,
    /// The sender's audio output latency, seconds (it enters the receiver's
    /// `output_latency`, paso 12 §Reloj 4).
    pub output_latency: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RemoteVideoMessage {
    /// First message each way: version and the session both have open.
    Hello {
        version: u32,
        session_id: String,
    },
    /// Receiver → sender, at `receiver_micros` of the receiver.
    Ping {
        id: u64,
        receiver_micros: i64,
    },
    /// Sender → receiver: the ping, stamped with the sender's clock.
    Pong {
        id: u64,
        receiver_micros: i64,
        sender_micros: i64,
    },
    Clock(ClockSample),
    /// Receiver → sender: clips whose files the receiver does not have.
    MissingFiles {
        clip_ids: Vec<String>,
    },
}

impl RemoteVideoMessage {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn from_json(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }
}

/// Exchanges kept: at 10 pings a second, the last 6.4 s. Short enough that a
/// ±50 ppm drift moves the offset by a third of a millisecond over the
/// window, long enough that some ping and some pong crossed the network fast.
pub const OFFSET_WINDOW: usize = 64;

/// The offset `sender − receiver` between the two monotonic clocks.
///
/// Each ping/pong pins it inside an interval: the pong's stamp happened
/// after the ping left and before the pong arrived, so
/// `sender − t_arrival ≤ offset ≤ sender − t_departure`. Intersecting the
/// recent intervals gives a bound as tight as the fastest single leg each way
/// (NTP's minimum-delay idea, without assuming the two legs are equal), and
/// the estimate is its middle.
#[derive(Debug, Default, Clone)]
pub struct OffsetEstimator {
    /// (lower, upper) bound of each recent exchange, in µs.
    bounds: VecDeque<(i64, i64)>,
}

impl OffsetEstimator {
    /// A pong for a ping sent at `receiver_sent` that came back at
    /// `receiver_received`, stamped `sender_micros` by the sender.
    pub fn add_exchange(&mut self, receiver_sent: i64, sender_micros: i64, receiver_received: i64) {
        if receiver_received < receiver_sent {
            return;
        }
        if self.bounds.len() == OFFSET_WINDOW {
            self.bounds.pop_front();
        }
        self.bounds.push_back((
            sender_micros - receiver_received,
            sender_micros - receiver_sent,
        ));
    }

    /// `sender − receiver` in µs, once there is at least one exchange.
    pub fn offset_micros(&self) -> Option<i64> {
        let lower = self.bounds.iter().map(|(lower, _)| *lower).max()?;
        let upper = self.bounds.iter().map(|(_, upper)| *upper).min()?;
        // Drift can make the latest intervals disagree slightly with the
        // oldest ones; the middle of the two is still the best guess.
        Some((lower + upper) / 2)
    }

    pub fn exchanges(&self) -> usize {
        self.bounds.len()
    }
}

/// After this long without a clock sample, the receiver stops following.
pub const LOSS_TIMEOUT_MICROS: i64 = 2_000_000;

/// What the receiver's runtime should do now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RemoteClockReading {
    /// Nothing heard yet, or no offset: show what "when stopped" says.
    Waiting,
    /// Follow this transport. `discontinuity` once per new generation.
    Following {
        position: f64,
        running: bool,
        rate: f64,
        output_latency: f64,
        discontinuity: bool,
        generation: u64,
    },
    /// The connection was lost more than 2 s ago: "when stopped" screen,
    /// until samples come back.
    Lost,
}

/// The sender's transport as seen from the receiver: the last sample,
/// extrapolated with the estimated offset.
#[derive(Debug, Default)]
pub struct RemoteClock {
    pub offset: OffsetEstimator,
    last: Option<ClockSample>,
    /// When (receiver µs) the last sample arrived.
    last_heard: Option<i64>,
    reported_generation: Option<u64>,
}

impl RemoteClock {
    /// A clock sample arrived at `receiver_micros`. Samples of an older
    /// generation, or older than the last one of the current generation,
    /// arrive out of order and are dropped.
    pub fn receive(&mut self, sample: ClockSample, receiver_micros: i64) {
        if let Some(last) = self.last {
            if sample.generation < last.generation
                || (sample.generation == last.generation
                    && sample.sender_micros < last.sender_micros)
            {
                return;
            }
        }
        self.last = Some(sample);
        self.last_heard = Some(receiver_micros);
    }

    /// The transport at `receiver_micros`.
    pub fn read(&mut self, receiver_micros: i64) -> RemoteClockReading {
        let (Some(sample), Some(heard), Some(offset)) =
            (self.last, self.last_heard, self.offset.offset_micros())
        else {
            return RemoteClockReading::Waiting;
        };
        if receiver_micros - heard > LOSS_TIMEOUT_MICROS {
            return RemoteClockReading::Lost;
        }
        let sender_now = receiver_micros + offset;
        let elapsed = (sender_now - sample.sender_micros) as f64 / 1_000_000.0;
        let position = if sample.running {
            sample.position + elapsed * sample.rate
        } else {
            sample.position
        };
        let discontinuity = self.reported_generation != Some(sample.generation);
        self.reported_generation = Some(sample.generation);
        RemoteClockReading::Following {
            position: position.max(0.0),
            running: sample.running,
            rate: sample.rate,
            output_latency: sample.output_latency,
            discontinuity,
            generation: sample.generation,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny deterministic generator: the tests must not depend on a seed
    /// the platform picks.
    struct Lcg(u64);

    impl Lcg {
        fn next_unit(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
        }
    }

    /// Two monotonic clocks: the sender's runs `ppm` faster and is offset by
    /// `offset_s`. `true_time` is a perfect external clock in µs.
    struct Clocks {
        offset_s: f64,
        ppm: f64,
    }

    impl Clocks {
        fn receiver(&self, true_micros: f64) -> i64 {
            true_micros as i64
        }
        fn sender(&self, true_micros: f64) -> i64 {
            (true_micros * (1.0 + self.ppm * 1e-6) + self.offset_s * 1e6) as i64
        }
    }

    fn simulate(seed: u64, ppm: f64) -> f64 {
        let clocks = Clocks { offset_s: 3.0, ppm };
        let mut random = Lcg(seed);
        let mut clock = RemoteClock::default();
        let mut worst: f64 = 0.0;
        let jitter = |random: &mut Lcg| random.next_unit() * 20_000.0;
        let start = 1_000_000.0;
        // 60 s of 10 Hz pings, 20 Hz clock samples of a running transport
        // that started at position 10 s at `start`.
        for tick in 0..1200u32 {
            let now = start + f64::from(tick) * 50_000.0;
            if tick % 2 == 0 {
                let out = jitter(&mut random);
                let back = jitter(&mut random);
                let sent = clocks.receiver(now);
                let stamped = clocks.sender(now + out);
                let received = clocks.receiver(now + out + back);
                clock.offset.add_exchange(sent, stamped, received);
            }
            let sample_delay = jitter(&mut random);
            let sender_now = clocks.sender(now);
            let transport = 10.0 + (sender_now - clocks.sender(start)) as f64 / 1e6;
            clock.receive(
                ClockSample {
                    generation: 1,
                    position: transport,
                    rate: 1.0,
                    running: true,
                    sender_micros: sender_now,
                    output_latency: 0.02,
                },
                clocks.receiver(now + sample_delay),
            );
            // Measure 10 s in, once the estimator has had time to converge.
            if tick > 200 {
                let read_at = now + sample_delay + 7_000.0;
                let truth = 10.0 + (clocks.sender(read_at) - clocks.sender(start)) as f64 / 1e6;
                if let RemoteClockReading::Following { position, .. } =
                    clock.read(clocks.receiver(read_at))
                {
                    worst = worst.max((position - truth).abs());
                }
            }
        }
        worst
    }

    /// Paso 12 C1: 3 s offset, 50 ppm drift, 0–20 ms jitter each way: the
    /// extrapolated clock stays within 2 ms once converged.
    #[test]
    fn the_extrapolated_clock_converges_within_two_milliseconds() {
        for seed in [1, 7, 42, 1234, 99_999] {
            for ppm in [50.0, -50.0, 0.0] {
                let worst = simulate(seed, ppm);
                assert!(
                    worst < 0.002,
                    "seed {seed}, {ppm} ppm: worst error {:.3} ms",
                    worst * 1000.0
                );
            }
        }
    }

    fn sample(generation: u64, position: f64, sender_micros: i64) -> ClockSample {
        ClockSample {
            generation,
            position,
            rate: 1.0,
            running: true,
            sender_micros,
            output_latency: 0.0,
        }
    }

    fn synced() -> RemoteClock {
        let mut clock = RemoteClock::default();
        // Offset 0, a perfect exchange.
        clock.offset.add_exchange(0, 0, 0);
        clock
    }

    /// Paso 12 C2: a new generation is a discontinuity (a seek on the
    /// receiver), reported once.
    #[test]
    fn a_new_generation_is_a_seek_reported_once() {
        let mut clock = synced();
        clock.receive(sample(1, 5.0, 0), 0);
        assert!(matches!(
            clock.read(0),
            RemoteClockReading::Following {
                discontinuity: true,
                ..
            }
        ));
        assert!(matches!(
            clock.read(10_000),
            RemoteClockReading::Following {
                discontinuity: false,
                ..
            }
        ));
        clock.receive(sample(2, 40.0, 20_000), 20_000);
        let RemoteClockReading::Following {
            position,
            discontinuity,
            ..
        } = clock.read(20_000)
        else {
            panic!("following")
        };
        assert!(discontinuity);
        assert_eq!(position, 40.0);
    }

    #[test]
    fn late_packets_of_an_old_generation_are_ignored() {
        let mut clock = synced();
        clock.receive(sample(2, 40.0, 100_000), 100_000);
        // Arrives late from before the jump.
        clock.receive(sample(1, 7.0, 90_000), 101_000);
        // And an older one of the current generation.
        clock.receive(sample(2, 39.9, 0), 102_000);
        let RemoteClockReading::Following {
            position,
            generation,
            ..
        } = clock.read(100_000)
        else {
            panic!("following")
        };
        assert_eq!(generation, 2);
        assert_eq!(position, 40.0);
    }

    /// Paso 12 C3: 2 s of extrapolation without samples, then lost; samples
    /// coming back resume it.
    #[test]
    fn a_lost_connection_extrapolates_two_seconds_then_gives_up() {
        let mut clock = synced();
        clock.receive(sample(1, 10.0, 0), 0);
        let RemoteClockReading::Following { position, .. } = clock.read(1_900_000) else {
            panic!("still following at 1.9 s")
        };
        assert!((position - 11.9).abs() < 1e-9);
        assert_eq!(clock.read(2_000_001), RemoteClockReading::Lost);
        clock.receive(sample(1, 12.5, 2_500_000), 2_500_000);
        assert!(matches!(
            clock.read(2_500_000),
            RemoteClockReading::Following { .. }
        ));
    }

    #[test]
    fn nothing_is_followed_before_the_offset_is_known() {
        let mut clock = RemoteClock::default();
        clock.receive(sample(1, 10.0, 0), 0);
        assert_eq!(clock.read(0), RemoteClockReading::Waiting);
    }

    #[test]
    fn a_stopped_transport_holds_its_position() {
        let mut clock = synced();
        clock.receive(
            ClockSample {
                running: false,
                ..sample(1, 33.0, 0)
            },
            0,
        );
        let RemoteClockReading::Following {
            position, running, ..
        } = clock.read(1_500_000)
        else {
            panic!("following")
        };
        assert!(!running);
        assert_eq!(position, 33.0);
    }

    /// The protocol round-trips through JSON, tagged by type.
    #[test]
    fn messages_round_trip() {
        let messages = [
            RemoteVideoMessage::Hello {
                version: PROTOCOL_VERSION,
                session_id: "abc".into(),
            },
            RemoteVideoMessage::Ping {
                id: 3,
                receiver_micros: 10,
            },
            RemoteVideoMessage::Pong {
                id: 3,
                receiver_micros: 10,
                sender_micros: 3_000_010,
            },
            RemoteVideoMessage::Clock(sample(4, 1.5, 99)),
            RemoteVideoMessage::MissingFiles {
                clip_ids: vec!["vc1".into()],
            },
        ];
        for message in messages {
            let json = message.to_json();
            assert_eq!(
                RemoteVideoMessage::from_json(&json),
                Some(message.clone()),
                "{json}"
            );
        }
        assert!(RemoteVideoMessage::Hello {
            version: 1,
            session_id: String::new()
        }
        .to_json()
        .contains("\"type\":\"hello\""));
        assert_eq!(
            RemoteVideoMessage::from_json("{\"type\":\"unknown\"}"),
            None
        );
    }
}
