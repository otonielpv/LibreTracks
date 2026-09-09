// Comparison of two capture routes around a transport event.
//
// What this deliberately does NOT do: assert sample equality. The live route
// rebuilds its Bungee voices at the seek target while the prepared file carries
// the history of one continuous render, so grain phase differs by construction
// and a sample-domain difference is expected, not a defect. What must hold is
// weaker and more useful:
//
//   1. the same content arrives at the same time (alignment),
//   2. at the same level (envelope error),
//   3. converging within a bounded window (recovery),
//   4. with neither route dropping out or clicking where the other does not.
//
// Everything below measures those four and nothing else. Thresholds live in the
// report, not here: this module reports numbers, it does not pass or fail.

// Short-time RMS over an interleaved capture, summed across channels.
export function envelope(samples, channels, hop, window) {
  if (!Number.isInteger(hop) || hop < 1) throw new Error('hop must be a positive integer');
  if (!Number.isInteger(window) || window < 1) throw new Error('window must be a positive integer');
  const frames = Math.floor(samples.length / channels);
  if (frames < window) return new Float64Array(0);
  const points = Math.floor((frames - window) / hop) + 1;
  const out = new Float64Array(points);
  for (let p = 0; p < points; p++) {
    let sum = 0;
    const begin = p * hop;
    for (let f = begin; f < begin + window; f++)
      for (let ch = 0; ch < channels; ch++) {
        const v = samples[f * channels + ch];
        sum += v * v;
      }
    out[p] = Math.sqrt(sum / (window * channels));
  }
  return out;
}

// Pearson correlation of `a` against `b` shifted by `lag`, over their overlap.
// Positive lag means a[i] matches b[i - lag]: `a` arrives LATER than `b`.
function correlationAt(a, b, lag) {
  const begin = Math.max(0, lag), end = Math.min(a.length, b.length + lag);
  const n = end - begin;
  if (n < 8) return { r: -1, n };
  let sa = 0, sb = 0;
  for (let i = begin; i < end; i++) { sa += a[i]; sb += b[i - lag]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = begin; i < end; i++) {
    const x = a[i] - ma, y = b[i - lag] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da <= 0 || db <= 0) return { r: 0, n };
  return { r: num / Math.sqrt(da * db), n };
}

// Every lag in ±maxLag, ordered by how far it is from zero: 0, -1, +1, -2, …
function* lagsByDistance(maxLag) {
  yield 0;
  for (let d = 1; d <= maxLag; d++) { yield -d; yield d; }
}

// Best integer lag of `a` relative to `b`, searched over ±maxLag.
//
// Ties go to the smallest shift. Musical material is close to periodic — a
// four-to-the-floor loop correlates just as well one bar late — so a search
// that accepts the first equally good answer it happens to visit can report a
// second of offset for two identical captures.
export function bestLag(a, b, maxLag) {
  let best = { lag: 0, r: -Infinity, n: 0 };
  for (const lag of lagsByDistance(maxLag)) {
    const { r, n } = correlationAt(a, b, lag);
    if (r > best.r) best = { lag, r, n };
  }
  return { ...best, rAtZero: correlationAt(a, b, 0).r };
}

const FLOOR = 1e-7; // ≈ -140 dBFS: keeps log of digital silence finite.
export const toDb = value => 20 * Math.log10(Math.max(value, FLOOR));

function quantile(values, q) {
  if (!values.length) return NaN;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

// Largest sample-to-sample step in a frame range, per route. Self-normalized
// against the route's own settled behaviour, so it does not depend on how
// spiky the fixture is.
export function slew(samples, channels, from, to) {
  let max = 0;
  for (let f = Math.max(1, from); f < to; f++)
    for (let ch = 0; ch < channels; ch++)
      max = Math.max(max, Math.abs(samples[f * channels + ch] - samples[(f - 1) * channels + ch]));
  return max;
}

export function slewProfile(samples, channels, from, to, q = 0.999) {
  const steps = [];
  for (let f = Math.max(1, from); f < to; f++)
    for (let ch = 0; ch < channels; ch++)
      steps.push(Math.abs(samples[f * channels + ch] - samples[(f - 1) * channels + ch]));
  return quantile(steps, q);
}

/**
 * Compare a live capture against a prepared capture around one event.
 *
 * `eventFrame` is the first frame rendered after the transport event.
 * `fadeFrames` is the engine's post-seek fade-in (FadeProcessor, 128 frames by
 * default): it is identical in both routes and is excluded from the content
 * comparison, then reported separately as the click window.
 */
export function compareRoutes({
  live, prepared, channels = 2, sampleRate = 48000,
  eventFrame, fadeFrames = 128,
  hop = 240, window = 480,          // 5 ms hop, 10 ms window
  maxLagSeconds = 1,
  settleSeconds = 4,
  clickWindowSeconds = 0.02,
  recoveryToleranceDb = 1,
  recoveryHoldSeconds = 0.2,
  referenceFloorDb = -60,
  minOverlapFraction = 0.75,
  alignmentConfidence = 0.9,
  dropoutFloorDb = -80, dropoutSignalDb = -40,
}) {
  const liveFrames = Math.floor(live.length / channels);
  const preparedFrames = Math.floor(prepared.length / channels);
  const frames = Math.min(liveFrames, preparedFrames);
  if (frames <= eventFrame) throw new Error('Capture ends before the event');

  const analysisStart = eventFrame + fadeFrames;
  const analysisEnd = Math.min(frames, analysisStart + Math.round(settleSeconds * sampleRate));
  const slice = (samples, from, to) =>
    samples.subarray(from * channels, to * channels);

  const liveWindow = slice(live, analysisStart, analysisEnd);
  const preparedWindow = slice(prepared, analysisStart, analysisEnd);
  const liveEnvelope = envelope(liveWindow, channels, hop, window);
  const preparedEnvelope = envelope(preparedWindow, channels, hop, window);
  // A shift is only allowed while it still compares most of the window.
  // Unclamped, a correlation over a third of the data can beat one over all of
  // it, so a half-second hole in one route is "explained" by sliding a second —
  // which then leaves almost nothing overlapping and empties every statistic
  // below while still printing plausible numbers.
  const shortest = Math.min(liveEnvelope.length, preparedEnvelope.length);
  const maxLagHops = Math.max(1, Math.min(
    Math.floor((maxLagSeconds * sampleRate) / hop),
    Math.floor(shortest * (1 - minOverlapFraction))));
  const coarse = bestLag(liveEnvelope, preparedEnvelope, maxLagHops);
  const atSearchLimit = Math.abs(coarse.lag) === maxLagHops;

  // Refine to ~1 ms around the coarse answer, so the reported offset is not
  // quantized to the 5 ms search grid.
  const fineHop = Math.max(1, Math.round(sampleRate / 1000));
  const fineWindow = Math.max(fineHop * 2, Math.round(sampleRate / 200));
  const fineLive = envelope(liveWindow, channels, fineHop, fineWindow);
  const finePrepared = envelope(preparedWindow, channels, fineHop, fineWindow);
  const centre = Math.round((coarse.lag * hop) / fineHop);
  const span = Math.max(2, Math.ceil(hop / fineHop) * 2);
  let fine = { lag: centre, r: -Infinity };
  // Same tie rule as the coarse pass: nearest to the coarse answer wins.
  for (const offset of lagsByDistance(span)) {
    const { r } = correlationAt(fineLive, finePrepared, centre + offset);
    if (r > fine.r) fine = { lag: centre + offset, r };
  }
  const lagFrames = fine.lag * fineHop;

  // Envelope error at the best alignment, as a function of time since the event.
  //
  // A dB difference is only meaningful where there is something to hear. Two
  // renders that sit at −92 and −105 dBFS differ by 13 dB and are both silence;
  // left ungated, those windows dominate every statistic and invent a recovery
  // time that no listener could perceive. Windows whose REFERENCE is below the
  // floor are therefore reported apart, never averaged in — and the two ways a
  // route can be wrong about silence are counted explicitly instead.
  const errors = [], timeline = [], ungated = [], reference = [], referenceTime = [], worst = [];
  let lowLevel = 0, silentInLive = 0, silentInPrepared = 0, maxAboveSignal = 0;
  for (let i = 0; i < liveEnvelope.length; i++) {
    const j = i - coarse.lag;
    if (j < 0 || j >= preparedEnvelope.length) continue;
    const a = toDb(liveEnvelope[i]), b = toDb(preparedEnvelope[j]);
    const error = Math.abs(a - b);
    ungated.push(error);
    reference.push(b);
    referenceTime.push(((i * hop) / sampleRate) * 1000);
    worst.push({ ms: ((i * hop) / sampleRate) * 1000, reference_db: b, live_db: a, error_db: error, gated: b <= referenceFloorDb });
    if (a < dropoutFloorDb && b > dropoutSignalDb) silentInLive++;
    if (b < dropoutFloorDb && a > dropoutSignalDb) silentInPrepared++;
    if (b <= referenceFloorDb) { lowLevel++; continue; }
    if (b > dropoutSignalDb) maxAboveSignal = Math.max(maxAboveSignal, error);
    errors.push(error);
    // Time is the window's START, not its midpoint: "recovered after X ms"
    // should read as the first window that was already inside tolerance, and
    // two identical captures should recover at 0.
    timeline.push(((i * hop) / sampleRate) * 1000);
  }

  // First moment after which the error stays inside tolerance for the hold.
  // Gated-out windows carry no evidence either way, so they neither break the
  // hold nor count towards it.
  const holdMs = recoveryHoldSeconds * 1000;
  let recoveryMs = null;
  for (let i = 0; i < errors.length && recoveryMs === null; i++) {
    if (errors[i] > recoveryToleranceDb) continue;
    const from = timeline[i];
    let held = false;
    for (let j = i; j < errors.length; j++) {
      if (timeline[j] - from >= holdMs) { held = true; break; }
      if (errors[j] > recoveryToleranceDb) break;
    }
    // A capture that ends before the hold elapses cannot confirm recovery.
    if (held) recoveryMs = from;
  }

  const bandError = (fromMs, toMs) => {
    const picked = errors.filter((_, i) => timeline[i] >= fromMs && timeline[i] < toMs);
    return picked.length ? { median_db: quantile(picked, 0.5), p95_db: quantile(picked, 0.95), points: picked.length } : null;
  };

  // Click check: the largest step right after the fade, against each route's
  // own settled steps. A route that clicks where the other does not shows a
  // much larger ratio; a fixture that is inherently spiky raises both.
  const clickTo = Math.min(frames, analysisStart + Math.round(clickWindowSeconds * sampleRate));
  const settledFrom = Math.max(analysisStart, analysisEnd - Math.round(sampleRate));
  const ratio = samples => {
    const baseline = slewProfile(samples, channels, settledFrom, analysisEnd);
    return baseline > 0 ? slew(samples, channels, analysisStart, clickTo) / baseline : null;
  };

  return {
    frames_compared: analysisEnd - analysisStart,
    event_frame: eventFrame,
    fade_frames: fadeFrames,
    alignment: {
      lag_frames: lagFrames,
      lag_ms: (lagFrames / sampleRate) * 1000,
      correlation: fine.r,
      correlation_at_zero_lag: coarse.rAtZero,
      coarse_lag_frames: coarse.lag * hop,
      search_limit_frames: maxLagHops * hop,
      // True when the search hit its own limit: the real offset may be larger
      // and this run did not bracket it. Never read the lag as final here.
      at_search_limit: atSearchLimit,
      // False means no shift inside the search lined the two captures up at
      // all. The offset printed above is then the least bad of a set of bad
      // answers, and every statistic that depends on it is meaningless: read
      // this before reading the lag.
      reliable: fine.r >= alignmentConfidence,
      confidence_threshold: alignmentConfidence,
      overlap_windows: coarse.n,
      available_windows: shortest,
    },
    // How loud the reference actually was. Without this a reader cannot tell an
    // engine that settles slowly from an event that landed on silence, and the
    // two look identical in every other number here.
    reference_level: {
      median_db: quantile(reference, 0.5),
      p10_db: quantile(reference, 0.1),
      first_100ms_median_db: (() => {
        const picked = reference.filter((_, i) => referenceTime[i] < 100);
        return picked.length ? quantile(picked, 0.5) : null;
      })(),
    },
    envelope_error: {
      reference_floor_db: referenceFloorDb,
      compared_windows: errors.length,
      low_level_windows: lowLevel,
      median_db: quantile(errors, 0.5),
      p95_db: quantile(errors, 0.95),
      max_db: errors.length ? errors.reduce((a, b) => Math.max(a, b), 0) : NaN,
      // Same statistic with the floor removed. Kept because a gate that hides
      // a real defect is worse than a noisy number nobody has explained yet.
      median_db_ungated: quantile(ungated, 0.5),
      p95_db_ungated: quantile(ungated, 0.95),
      max_db_ungated: ungated.length ? ungated.reduce((a, b) => Math.max(a, b), 0) : NaN,
      max_db_above_signal: maxAboveSignal,
      signal_floor_db: dropoutSignalDb,
      first_100ms: bandError(0, 100),
      to_500ms: bandError(100, 500),
      after_500ms: bandError(500, Infinity),
    },
    recovery_ms: recoveryMs,
    // The windows that actually drove the numbers above, so a recovery time can
    // be read for what it is. A 1,3 dB difference in a burst tail at −57 dBFS
    // and an engine that needs 660 ms to settle produce the same figure, and
    // only this list separates them.
    worst_windows: worst.filter(w => !w.gated).sort((a, b) => b.error_db - a.error_db).slice(0, 6)
      .map(({ ms, reference_db, live_db, error_db }) => ({ ms, reference_db, live_db, error_db })),
    dropout_windows: silentInLive + silentInPrepared,
    silent_in_live_windows: silentInLive,
    silent_in_prepared_windows: silentInPrepared,
    click: {
      live_slew_ratio: ratio(live),
      prepared_slew_ratio: ratio(prepared),
      window_ms: clickWindowSeconds * 1000,
    },
  };
}
