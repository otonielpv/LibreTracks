// Deterministic transient-rich fixture for the seek-fidelity capture.
//
// The tonal fixture used by the streaming/DSP benches cannot expose an
// alignment error: a pure sine slid by 20 ms still correlates almost perfectly
// with itself. This one carries sharp events (impulses, percussive bursts) so a
// misalignment shows, and a slow envelope whose period (4.7 s) shares no whole
// multiple with the 4 s pattern, so sliding the signal by a whole pattern
// cannot look like a match either.
//
// Everything is placed in whole frames. Deriving event positions from seconds
// puts them a rounding error away from a sample boundary, which silently drops
// single-sample impulses.
//
// PCM16 stereo at 48 kHz, peak below 0.40 so warp overshoot still leaves
// headroom under the mixer's 0.98 soft limiter.
import { closeSync, openSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const SAMPLE_RATE = 48000;
export const PATTERN_FRAMES = 4 * SAMPLE_RATE;
const TONE_END = 1.2 * SAMPLE_RATE;          // 0.00 – 1.20 s sustained tone
const SILENCE_END = 1.4 * SAMPLE_RATE;       // 1.20 – 1.40 s silence
const IMPULSE_END = 2.4 * SAMPLE_RATE;       // 1.40 – 2.40 s five impulses
const BURST_END = 3.2 * SAMPLE_RATE;         // 2.40 – 3.20 s four bursts
const EVENT_SPACING = 0.2 * SAMPLE_RATE;     // impulses and bursts, 200 ms apart
const RAMP = 0.005 * SAMPLE_RATE;            // 5 ms edges: no gratuitous clicks
const ENVELOPE_FRAMES = 4.7 * SAMPLE_RATE;

// xorshift32: the same bursts on every machine and every run.
function noise(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x80000000 - 1;
  };
}

function edge(position, length) {
  const rise = Math.min(1, position / RAMP);
  const fall = Math.min(1, (length - position) / RAMP);
  const shape = Math.min(rise, fall);
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, shape)));
}

// One frame of the pattern for the given track. `random` is consumed in frame
// order, so the burst noise is reproducible.
export function patternAt(frame, track, random) {
  const cycle = Math.floor(frame / PATTERN_FRAMES);
  const phase = frame - cycle * PATTERN_FRAMES;
  const envelope = 0.7 + 0.3 * Math.sin((2 * Math.PI * frame) / ENVELOPE_FRAMES + track);
  let value = 0;
  if (phase < TONE_END) {
    // Sustained tone; the pitch walks with the cycle so two cycles differ.
    const hz = 220 * Math.pow(2, ((cycle + track) % 5) / 12);
    value = 0.22 * Math.sin((2 * Math.PI * hz * phase) / SAMPLE_RATE) * edge(phase, TONE_END);
  } else if (phase < SILENCE_END) {
    value = 0; // Silence: content present in one route only becomes visible.
  } else if (phase < IMPULSE_END) {
    // Five single-frame impulses 200 ms apart, alternating sign.
    const since = phase - SILENCE_END;
    if (since % EVENT_SPACING === 0 && since / EVENT_SPACING < 5)
      value = (since / EVENT_SPACING) % 2 ? -0.38 : 0.38;
  } else if (phase < BURST_END) {
    // Four percussive bursts: the anchors the alignment search relies on.
    const since = phase - IMPULSE_END;
    const decay = Math.exp(-((since % EVENT_SPACING) / SAMPLE_RATE) / 0.025);
    value = 0.35 * decay * random();
  } else {
    // Linear chirp 300 → 3000 Hz across the last 800 ms.
    const since = phase - BURST_END;
    const length = PATTERN_FRAMES - BURST_END;
    const seconds = since / SAMPLE_RATE;
    const sweep = (3000 - 300) / (length / SAMPLE_RATE);
    value = 0.22 * Math.sin(2 * Math.PI * (300 * seconds + (sweep * seconds * seconds) / 2))
      * edge(since, length);
  }
  return value * envelope;
}

// Right is the same signal delayed and attenuated, so a collapsed or swapped
// channel is not silently equal to the correct one.
export const RIGHT_DELAY_FRAMES = 137;
export const RIGHT_GAIN = 0.85;

export function writeFixture(path, { seconds, track = 0 }) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600)
    throw new Error('Fixture length must be 1..600 whole seconds');
  const random = noise(0x9e3779b9 + track * 2654435761);
  const history = new Float64Array(SAMPLE_RATE);
  const header = Buffer.alloc(44);
  const dataBytes = seconds * SAMPLE_RATE * 4;
  header.write('RIFF'); header.writeUInt32LE(dataBytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  const hash = createHash('sha256');
  const fd = openSync(path, 'wx');
  let peak = 0, impulses = 0;
  try {
    const write = data => {
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
      hash.update(data);
    };
    write(header);
    const chunk = Buffer.alloc(SAMPLE_RATE * 4);
    for (let second = 0; second < seconds; second++) {
      for (let f = 0; f < SAMPLE_RATE; f++) {
        const frame = second * SAMPLE_RATE + f;
        const left = patternAt(frame, track, random);
        // Inside the impulse window the impulses are the only non-zero frames.
        if (left !== 0 && frame % PATTERN_FRAMES >= SILENCE_END
          && frame % PATTERN_FRAMES < IMPULSE_END) impulses++;
        history[frame % history.length] = left;
        const delayed = frame >= RIGHT_DELAY_FRAMES
          ? history[(frame - RIGHT_DELAY_FRAMES) % history.length] : 0;
        const right = delayed * RIGHT_GAIN;
        peak = Math.max(peak, Math.abs(left), Math.abs(right));
        chunk.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left * 32767))), f * 4);
        chunk.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right * 32767))), f * 4 + 2);
      }
      write(chunk);
    }
  } finally { closeSync(fd); }
  if (peak > 0.45) throw new Error(`Fixture peak ${peak} leaves too little headroom`);
  // Five impulses per whole 4 s pattern. Without this the generator can lose
  // every impulse to a rounding change and still produce a plausible file.
  const expected = Math.floor(seconds / 4) * 5;
  if (impulses < expected)
    throw new Error(`Fixture has ${impulses} impulses, expected at least ${expected}`);
  return { bytes: dataBytes + 44, sha256: hash.digest('hex'), peak, impulses, sample_rate: SAMPLE_RATE };
}
