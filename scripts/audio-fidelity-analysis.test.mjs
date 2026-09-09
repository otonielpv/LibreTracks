// Every case injects a defect the analyzer must name. Deleting a metric or
// inverting the sign of the alignment search has to make one of these fail:
// a fidelity report is only worth reading if its analyzer knows how to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRoutes, controlResponse, envelope, bestLag, toDb } from './audio-fidelity-analysis.mjs';

const SR = 48000, CH = 2, EVENT = 4800, FADE = 128, SECONDS = 2;

// Decaying sine bursts 200 ms apart: transient enough to align on, smooth
// enough that an injected step stands out from the material itself. The slow
// 1.7 s envelope is not a whole multiple of the 200 ms burst period, so the
// signal never matches a shifted copy of itself — otherwise the alignment
// assertions below would pass on a search that reports any burst-multiple.
function signal(frames, { seed = 1 } = {}) {
  const out = new Float32Array(frames * CH);
  for (let f = 0; f < frames; f++) {
    const since = (f % 9600) / SR;
    const slow = 0.6 + 0.4 * Math.sin((2 * Math.PI * f) / (SR * 1.7));
    const value = (0.3 * Math.exp(-since / 0.03) * Math.sin(2 * Math.PI * (180 + seed * 20) * since)
      + 0.05 * Math.sin((2 * Math.PI * 440 * f) / SR)) * slow;
    out[f * CH] = value;
    out[f * CH + 1] = value * 0.85;
  }
  return out;
}

const frames = EVENT + SECONDS * SR;
const base = signal(frames);
const clone = () => Float32Array.from(base);

// Shift the whole capture by `delay` frames (positive = arrives later).
function delayed(delay) {
  const out = new Float32Array(base.length);
  for (let f = 0; f < frames; f++)
    for (let ch = 0; ch < CH; ch++) {
      const source = f - delay;
      out[f * CH + ch] = source >= 0 && source < frames ? base[source * CH + ch] : 0;
    }
  return out;
}

const run = (live, prepared, options = {}) => compareRoutes({
  live, prepared, channels: CH, sampleRate: SR, eventFrame: EVENT, fadeFrames: FADE,
  settleSeconds: 1.5, ...options,
});

test('identical captures report no offset, no error, no dropout', () => {
  const result = run(clone(), clone());
  assert.equal(result.alignment.lag_frames, 0);
  assert.ok(result.alignment.correlation > 0.999, `correlation ${result.alignment.correlation}`);
  assert.ok(result.envelope_error.max_db < 0.001, `max ${result.envelope_error.max_db}`);
  assert.equal(result.dropout_windows, 0);
  assert.equal(result.recovery_ms, 0);
});

test('a live route arriving late is reported as a positive offset', () => {
  const result = run(delayed(240), clone());
  assert.equal(result.alignment.lag_frames, 240);
  assert.ok(result.alignment.correlation > 0.99);
  // The zero-lag correlation must be visibly worse, or the search proved nothing.
  assert.ok(result.alignment.correlation_at_zero_lag < 0.95,
    `zero-lag correlation ${result.alignment.correlation_at_zero_lag}`);
});

test('a live route arriving early is reported as a negative offset', () => {
  const result = run(clone(), delayed(480));
  assert.equal(result.alignment.lag_frames, -480);
});

test('a level difference is reported in dB and never recovers', () => {
  const live = clone();
  for (let f = EVENT; f < frames; f++)
    for (let ch = 0; ch < CH; ch++) live[f * CH + ch] *= 0.5; // −6.02 dB
  const result = run(live, clone());
  assert.ok(Math.abs(result.envelope_error.median_db - 6.02) < 0.1,
    `median ${result.envelope_error.median_db}`);
  assert.equal(result.recovery_ms, null);
});

test('a difference that decays is reported as a recovery window', () => {
  const live = clone();
  const settle = Math.round(0.3 * SR);
  for (let f = EVENT; f < EVENT + settle; f++) {
    const gain = 0.5 + 0.5 * ((f - EVENT) / settle);
    for (let ch = 0; ch < CH; ch++) live[f * CH + ch] *= gain;
  }
  const result = run(live, clone());
  assert.ok(result.recovery_ms !== null, 'a converging route must report a recovery window');
  assert.ok(result.recovery_ms > 0 && result.recovery_ms < 400, `recovery ${result.recovery_ms} ms`);
});

test('silence in one route only is counted as a dropout', () => {
  const live = clone();
  for (let f = EVENT; f < frames; f++)
    for (let ch = 0; ch < CH; ch++) live[f * CH + ch] = 0;
  const result = run(live, clone());
  assert.ok(result.dropout_windows > 100, `dropouts ${result.dropout_windows}`);
});

test('a difference confined to near-silence is set apart, not averaged in', () => {
  // −100 dBFS in one route against −112 in the other is a 12 dB difference and
  // two silences. Ungated it would invent a recovery time; gated it must not.
  const live = clone(), prepared = clone();
  const quietFrom = EVENT + Math.round(0.5 * SR), quietTo = quietFrom + Math.round(0.5 * SR);
  for (let f = quietFrom; f < quietTo; f++)
    for (let ch = 0; ch < CH; ch++) {
      live[f * CH + ch] = 1e-5;
      prepared[f * CH + ch] = 4e-6;
    }
  const result = run(live, prepared);
  assert.ok(result.envelope_error.low_level_windows > 50,
    `low level windows ${result.envelope_error.low_level_windows}`);
  assert.ok(result.envelope_error.max_db < 0.01, `gated max ${result.envelope_error.max_db}`);
  assert.ok(result.envelope_error.max_db_ungated > 5,
    `ungated max ${result.envelope_error.max_db_ungated} must keep the raw evidence`);
  assert.equal(result.recovery_ms, 0);
});

test('content present in one route only survives the level gate', () => {
  // The gate drops windows whose REFERENCE is silent, so this is exactly the
  // shape of defect it could hide: the prepared route silent, the live route
  // playing. It has to be counted, not gated away.
  const live = clone(), prepared = clone();
  const from = EVENT + Math.round(0.5 * SR), to = from + Math.round(0.5 * SR);
  for (let f = from; f < to; f++)
    for (let ch = 0; ch < CH; ch++) prepared[f * CH + ch] = 0;
  const result = run(live, prepared);
  assert.ok(result.silent_in_prepared_windows > 20,
    `silent-in-prepared windows ${result.silent_in_prepared_windows}`);
  assert.equal(result.silent_in_live_windows, 0);
});

test('a step in one route only raises that route slew ratio', () => {
  const live = clone();
  const click = EVENT + FADE + 10;
  for (let ch = 0; ch < CH; ch++) live[click * CH + ch] += 0.8;
  const result = run(live, clone());
  assert.ok(result.click.live_slew_ratio > 5 * result.click.prepared_slew_ratio,
    `live ${result.click.live_slew_ratio} vs prepared ${result.click.prepared_slew_ratio}`);
});

test('the level of the reference is reported alongside the error', () => {
  // An event that lands on silence and an engine that settles slowly produce
  // the same error numbers. Only the reference level separates them, so it has
  // to be there: this exact confusion already read as a 2,9 dB transient once.
  const live = clone(), prepared = clone();
  const quietTo = EVENT + Math.round(0.1 * SR);
  for (let f = EVENT; f < quietTo; f++)
    for (let ch = 0; ch < CH; ch++) { live[f * CH + ch] *= 1e-4; prepared[f * CH + ch] *= 1e-4; }
  const quiet = run(live, prepared), normal = run(clone(), clone());
  assert.ok(quiet.reference_level.first_100ms_median_db < -70,
    `quiet onset reported at ${quiet.reference_level.first_100ms_median_db} dBFS`);
  assert.ok(normal.reference_level.first_100ms_median_db > -40,
    `normal onset reported at ${normal.reference_level.first_100ms_median_db} dBFS`);
});

test('an offset the search cannot reach is flagged as unreliable', () => {
  // The clamp that stops a hole from sliding the window also means a genuinely
  // huge offset cannot be measured. It has to say so rather than report the
  // limit as if it were the answer.
  const result = run(delayed(SR), clone(), { maxLagSeconds: 0.05 });
  assert.equal(result.alignment.reliable, false);
  assert.ok(result.alignment.correlation < 0.5, `correlation ${result.alignment.correlation}`);
  assert.ok(Math.abs(result.alignment.lag_frames) <= result.alignment.search_limit_frames + 48,
    `lag ${result.alignment.lag_frames} beyond limit ${result.alignment.search_limit_frames}`);
  // The reachable cases must still be trusted, or the flag is just noise.
  assert.equal(run(clone(), clone()).alignment.reliable, true);
  assert.equal(run(delayed(240), clone()).alignment.reliable, true);
});

test('envelope and lag helpers behave as the comparison assumes', () => {
  const constant = new Float32Array(1000 * CH).fill(0.5);
  const rms = envelope(constant, CH, 100, 200);
  assert.ok(rms.every(v => Math.abs(v - 0.5) < 1e-6), 'RMS of a constant must be that constant');
  const a = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i / 3));
  const b = Float64Array.from({ length: 64 }, (_, i) => Math.sin((i - 4) / 3));
  // a[i] == b[i + 4], so `a` leads `b`: the reported lag must be negative.
  assert.equal(bestLag(a, b, 12).lag, -4);
  assert.ok(toDb(0) < -100, 'digital silence must map to a finite floor');
});

// The control-response tests need a stationary level: the bursty signal above
// carries a 1,7 s envelope on purpose, and over half-second windows that drift
// is bigger than the step being measured. Here the level itself is the subject.
const CONTROL_EVENT = 48000;
const steadyFrames = CONTROL_EVENT + 2 * SR;
function steady() {
  const out = new Float32Array(steadyFrames * CH);
  for (let f = 0; f < steadyFrames; f++) {
    const value = 0.3 * Math.sin((2 * Math.PI * 220 * f) / SR);
    out[f * CH] = value;
    out[f * CH + 1] = value * 0.85;
  }
  return out;
}
const response = (samples, options = {}) =>
  controlResponse(samples, CH, CONTROL_EVENT, { sampleRate: SR, ...options });

test('a gain change is reported as its exact dB step, per channel', () => {
  const live = steady();
  for (let f = CONTROL_EVENT; f < steadyFrames; f++)
    for (let ch = 0; ch < CH; ch++) live[f * CH + ch] *= 0.5;
  for (const delta of response(live).delta_db)
    assert.ok(Math.abs(delta + 6.02) < 0.2, `delta ${delta} dB, expected -6,02`);
  // An unchanged route must report no step, or the metric flags every run.
  for (const delta of response(steady()).delta_db)
    assert.ok(Math.abs(delta) < 0.1, `unchanged route reported ${delta} dB`);
});

test('a one-channel change is not hidden by the other channel', () => {
  const live = steady();
  for (let f = CONTROL_EVENT; f < steadyFrames; f++) live[f * CH + 1] = 0; // hard left
  const result = response(live);
  assert.ok(Math.abs(result.delta_db[0]) < 0.1, `left moved ${result.delta_db[0]} dB`);
  assert.ok(result.delta_db[1] < -60, `right only dropped ${result.delta_db[1]} dB`);
});

test('muting reads as a drop to the floor, and a short capture is refused', () => {
  const live = steady();
  for (let f = CONTROL_EVENT; f < steadyFrames; f++)
    for (let ch = 0; ch < CH; ch++) live[f * CH + ch] = 0;
  for (const delta of response(live).delta_db)
    assert.ok(delta < -80, `mute only dropped ${delta} dB`);
  // The window must not be allowed to run off either end of the capture.
  assert.throws(() => response(live, { windowSeconds: 5 }), /too short/);
});
