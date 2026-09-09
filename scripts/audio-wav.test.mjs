// The reader and the error statistics are what turn a format decision into a
// number, so both have to be pinned against values computed by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWav, compareSamples } from './audio-wav.mjs';
import { writeFixture, SAMPLE_RATE } from './audio-fidelity-fixture.mjs';

const dir = mkdtempSync(join(tmpdir(), 'lt-wav-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function header(format, channels, bits, dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(dataBytes + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(format, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * channels * bits / 8, 28);
  h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

test('reads 16-bit PCM with libsndfile normalization', () => {
  const data = Buffer.alloc(8);
  for (const [i, v] of [32767, -32768, 16384, 0].entries()) data.writeInt16LE(v, i * 2);
  const path = join(dir, 'pcm16.wav');
  writeFileSync(path, Buffer.concat([header(1, 2, 16, data.length), data]));
  const wav = readWav(path);
  assert.equal(wav.channels, 2);
  assert.equal(wav.frames, 2);
  assert.deepEqual([...wav.samples], [32767 / 32768, -1, 0.5, 0]);
});

test('reads 32-bit float unchanged', () => {
  const data = Buffer.alloc(8);
  data.writeFloatLE(0.25, 0); data.writeFloatLE(-0.75, 4);
  const path = join(dir, 'float32.wav');
  writeFileSync(path, Buffer.concat([header(3, 2, 32, data.length), data]));
  assert.deepEqual([...readWav(path).samples], [0.25, -0.75]);
});

test('refuses a file it would have to guess about', () => {
  const path = join(dir, 'unsupported.wav');
  writeFileSync(path, Buffer.concat([header(1, 2, 24, 6), Buffer.alloc(6)]));
  assert.throws(() => readWav(path), /Unsupported WAV format/);
  const truncated = join(dir, 'truncated.wav');
  writeFileSync(truncated, Buffer.concat([header(3, 2, 32, 4096), Buffer.alloc(8)]));
  assert.throws(() => readWav(truncated), /Truncated/);
});

test('reads back what the fixture generator wrote', () => {
  const path = join(dir, 'fixture.wav');
  const written = writeFixture(path, { seconds: 2, track: 0 });
  const wav = readWav(path);
  assert.equal(wav.sampleRate, SAMPLE_RATE);
  assert.equal(wav.channels, 2);
  assert.equal(wav.frames, 2 * SAMPLE_RATE);
  let peak = 0;
  for (const v of wav.samples) peak = Math.max(peak, Math.abs(v));
  // The fixture is written at 32767 (the usual scale for authoring PCM16
  // material, which keeps ±1 symmetric) and read back at 32768, so the peak
  // returns one part in 32768 low. The preparer instead writes at 32768
  // precisely so its own round trip is exact; see bench_prepare_warp.cpp.
  assert.ok(Math.abs(peak - written.peak) < 1e-4,
    `peak ${peak} against the ${written.peak} the generator reported`);
});

test('quantization error is measured against the programme level', () => {
  // A known 6 dB attenuation must read as a signal-to-error of 0 dB against
  // itself: the error equals the removed half.
  const reference = Float32Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin(i / 8));
  const halved = Float32Array.from(reference, v => v * 0.5);
  const stats = compareSamples(reference, halved);
  assert.ok(Math.abs(stats.signal_to_error_db - 6.02) < 0.05, `${stats.signal_to_error_db} dB`);
  // Rounding a float signal to 16 bits must land near the textbook floor.
  const quantized = Float32Array.from(reference, v => Math.round(v * 32768) / 32768);
  const q = compareSamples(reference, quantized);
  assert.ok(q.signal_to_error_db > 85 && q.signal_to_error_db < 105,
    `16-bit signal-to-error came out at ${q.signal_to_error_db} dB`);
  assert.throws(() => compareSamples(reference, reference.subarray(1)), /Length mismatch/);
});
