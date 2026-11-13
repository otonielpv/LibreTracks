use super::*;
use crate::{analyze_click, analyze_guide};

const RATE: u32 = 48_000;

fn seconds(n: usize) -> f64 {
    n as f64 / f64::from(RATE)
}

/// Deterministic white noise in [-1, 1].
struct Noise(u32);
impl Noise {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.0 >> 8) as f32 / (1 << 23) as f32 * 2.0 - 1.0
    }
}

/// A dry click: 8 ms of 1 kHz with a fast decay.
fn add_click(signal: &mut [f32], at: f64, amplitude: f32) {
    add_tone(signal, at, 0.008, 1000.0, amplitude, 0.002);
}

/// A click that rings for `length` seconds, decaying exponentially.
fn add_tone(signal: &mut [f32], at: f64, length: f64, hz: f64, amplitude: f32, tau: f64) {
    let start = (at * f64::from(RATE)) as usize;
    let frames = (length * f64::from(RATE)) as usize;
    for i in 0..frames {
        let Some(sample) = signal.get_mut(start + i) else { break };
        let t = seconds(i);
        *sample += amplitude
            * ((-t / tau).exp() * (2.0 * std::f64::consts::PI * hz * t).sin()) as f32;
    }
}

/// A burst of "speech": noise shaped in syllables of 120 ms that never quite
/// fall silent, `length` seconds long.
fn add_voice(signal: &mut [f32], at: f64, length: f64, amplitude: f32, noise: &mut Noise) {
    let start = (at * f64::from(RATE)) as usize;
    let frames = (length * f64::from(RATE)) as usize;
    for i in 0..frames {
        let Some(sample) = signal.get_mut(start + i) else { break };
        let t = seconds(i);
        let syllable = 0.6 + 0.4 * (std::f64::consts::PI * t / 0.12).sin().abs();
        let edges = (t / 0.01).min((length - t) / 0.01).min(1.0);
        *sample += amplitude * (syllable * edges) as f32 * noise.next();
    }
}

/// (start, end) of each voice burst: 300 to 700 ms, every 2.3 s.
fn voice_bursts(total: f64) -> Vec<(f64, f64)> {
    let mut bursts = Vec::new();
    let mut at = 1.13;
    let mut index = 0;
    while at + 0.7 < total {
        let length = [0.3, 0.5, 0.7, 0.45][index % 4];
        bursts.push((at, at + length));
        at += 2.3;
        index += 1;
    }
    bursts
}

struct Material {
    mix: Vec<f32>,
    voice_only: Vec<f32>,
    beats: Vec<f64>,
    bursts: Vec<(f64, f64)>,
}

fn click_and_voice(bpm: f64, total: f64) -> Material {
    let frames = (total * f64::from(RATE)) as usize;
    let mut mix = vec![0.0_f32; frames];
    let mut voice_only = vec![0.0_f32; frames];
    let period = 60.0 / bpm;
    let beats: Vec<f64> = (0..)
        .map(|n| 0.5 + n as f64 * period)
        .take_while(|t| *t + 0.05 < total)
        .collect();
    for (n, &beat) in beats.iter().enumerate() {
        add_click(&mut mix, beat, if n % 4 == 0 { 0.8 } else { 0.6 });
    }
    let bursts = voice_bursts(total);
    for &(from, to) in &bursts {
        add_voice(&mut voice_only, from, to - from, 0.3, &mut Noise(from.to_bits() as u32));
    }
    for (m, v) in mix.iter_mut().zip(&voice_only) {
        *m += v;
    }
    Material { mix, voice_only, beats, bursts }
}

fn peak_near(signal: &[f32], at: f64, width: f64) -> f32 {
    let from = (((at - width).max(0.0)) * f64::from(RATE)) as usize;
    let to = (((at + width) * f64::from(RATE)) as usize).min(signal.len());
    signal[from..to].iter().fold(0.0_f32, |max, x| max.max(x.abs()))
}

fn energy(signal: &[f32], from: f64, to: f64) -> f64 {
    let a = (from * f64::from(RATE)) as usize;
    let b = ((to * f64::from(RATE)) as usize).min(signal.len());
    signal[a..b].iter().map(|x| f64::from(*x).powi(2)).sum()
}

#[test]
fn the_click_outside_the_words_and_the_words_survive_the_split() {
    let material = click_and_voice(105.0, 30.0);
    let split = split_click_and_speech(&material.mix, RATE);

    let inside = |t: f64| {
        material
            .bursts
            .iter()
            .any(|&(from, to)| t > from - 0.02 && t < to + 0.02)
    };
    let outside: Vec<f64> = material.beats.iter().copied().filter(|t| !inside(*t)).collect();
    let recovered = outside
        .iter()
        .filter(|&&t| peak_near(&split.click, t + 0.003, 0.004) > 0.4)
        .count();
    assert!(
        recovered as f64 >= 0.95 * outside.len() as f64,
        "{recovered} de {} golpes fuera de la voz",
        outside.len()
    );
    // And no click left in the speech outside the words.
    for &t in &outside {
        assert!(peak_near(&split.speech, t + 0.003, 0.006) < 0.05, "golpe en la voz a {t}");
    }

    let kept: f64 = material.bursts.iter().map(|&(a, b)| energy(&split.speech, a, b)).sum();
    let voice: f64 = material.bursts.iter().map(|&(a, b)| energy(&material.voice_only, a, b)).sum();
    assert!(kept >= 0.9 * voice, "la voz conserva {:.0} %", 100.0 * kept / voice);
}

#[test]
fn a_click_with_a_60_ms_tail_stays_a_click() {
    let mut signal = vec![0.0_f32; RATE as usize * 6];
    for n in 0..10 {
        add_tone(&mut signal, 0.4 + n as f64 * 0.5, 0.06, 2000.0, 0.8, 0.012);
    }
    let split = split_click_and_speech(&signal, RATE);
    let speech_peak = split.speech.iter().fold(0.0_f32, |m, x| m.max(x.abs()));
    assert!(speech_peak < 1.0e-3, "la cola se fue a la voz: {speech_peak}");
    for n in 0..10 {
        assert!(peak_near(&split.click, 0.4 + n as f64 * 0.5 + 0.003, 0.004) > 0.5);
    }
}

#[test]
fn only_click_leaves_the_speech_empty_and_only_voice_the_click() {
    let mut click_only = vec![0.0_f32; RATE as usize * 8];
    for n in 0..20 {
        add_click(&mut click_only, 0.3 + n as f64 * 0.3, 0.7);
    }
    let split = split_click_and_speech(&click_only, RATE);
    assert!(split.speech.iter().all(|x| x.abs() < 1.0e-3));
    assert_eq!(split.click, click_only);

    let mut voice_only = vec![0.0_f32; RATE as usize * 8];
    let mut noise = Noise(7);
    for &(from, to) in &voice_bursts(8.0) {
        add_voice(&mut voice_only, from, to - from, 0.3, &mut noise);
    }
    let split = split_click_and_speech(&voice_only, RATE);
    assert!(split.click.iter().all(|x| *x == 0.0));
    assert_eq!(split.speech, voice_only);

    let silence = vec![0.0_f32; 1000];
    let split = split_click_and_speech(&silence, RATE);
    assert_eq!((split.click.len(), split.speech.len()), (1000, 1000));
}

#[test]
fn after_the_split_the_click_reads_its_exact_tempo() {
    let material = click_and_voice(105.0, 30.0);
    let tempos = |samples: &[f32]| -> Vec<f64> {
        analyze_click(samples, RATE, 4).segments.iter().map(|s| s.bpm).collect()
    };
    let exact = |bpms: &[f64]| !bpms.is_empty() && bpms.iter().all(|bpm| (bpm - 105.0).abs() < 0.5);

    let unsplit = tempos(&material.mix);
    assert!(!exact(&unsplit), "sin partir ya salía exacto: {unsplit:?} (el test no demuestra nada)");
    let split = split_click_and_speech(&material.mix, RATE);
    let after = tempos(&split.click);
    assert!(exact(&after), "tras partir: {after:?}");
}

#[test]
fn after_the_split_each_spoken_cue_is_its_own_announcement() {
    // Eighths at 105: the click never leaves 0.4 s of silence, so unsplit the
    // whole song is one announcement.
    let material = click_and_voice(210.0, 30.0);
    let unsplit = analyze_guide(&material.mix, RATE, &[], None);
    assert_eq!(unsplit.announcements.len(), 1, "{:?}", unsplit.announcements);

    let split = split_click_and_speech(&material.mix, RATE);
    let after = analyze_guide(&split.speech, RATE, &[], None);
    assert_eq!(after.announcements.len(), material.bursts.len());
    for (announcement, &(from, _)) in after.announcements.iter().zip(&material.bursts) {
        assert!((announcement.start_seconds - from).abs() < 0.05, "{announcement:?} vs {from}");
    }
}
