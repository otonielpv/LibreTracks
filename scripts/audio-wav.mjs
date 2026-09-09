// Minimal reader for the canonical WAVs this repo's benches write: 44-byte
// header, no extra chunks, 16-bit PCM or 32-bit IEEE float. It refuses anything
// else on purpose — a reader that guesses at unexpected files would silently
// misread the very measurement it exists to support.
import { readFileSync } from 'node:fs';

export function readWav(path) {
  const raw = readFileSync(path);
  if (raw.length < 44 || raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`Not a RIFF/WAVE file: ${path}`);
  if (raw.toString('ascii', 12, 16) !== 'fmt ' || raw.readUInt32LE(16) !== 16)
    throw new Error(`Expected a 16-byte fmt chunk at offset 12: ${path}`);
  const format = raw.readUInt16LE(20), channels = raw.readUInt16LE(22);
  const sampleRate = raw.readUInt32LE(24), bits = raw.readUInt16LE(34);
  if (raw.toString('ascii', 36, 40) !== 'data')
    throw new Error(`Expected the data chunk at offset 36: ${path}`);
  const dataBytes = raw.readUInt32LE(40);
  if (dataBytes > raw.length - 44) throw new Error(`Truncated data chunk: ${path}`);
  const bytesPerSample = bits / 8;
  if (raw.readUInt16LE(32) !== channels * bytesPerSample)
    throw new Error(`Block align disagrees with channels and depth: ${path}`);
  const count = dataBytes / bytesPerSample;
  if (!Number.isInteger(count)) throw new Error(`Data length is not a whole number of samples: ${path}`);
  const samples = new Float32Array(count);
  if (format === 3 && bits === 32) {
    for (let i = 0; i < count; i++) samples[i] = raw.readFloatLE(44 + i * 4);
  } else if (format === 1 && bits === 16) {
    // 1/32768, matching libsndfile's default normalization on read, so a file
    // written from float and read back here lands on the same values the engine
    // would see.
    for (let i = 0; i < count; i++) samples[i] = raw.readInt16LE(44 + i * 2) / 32768;
  } else {
    throw new Error(`Unsupported WAV format ${format} at ${bits} bits: ${path}`);
  }
  return { channels, sampleRate, bits, format, frames: count / channels, samples };
}

// Error statistics of `candidate` against `reference`, in dB relative to full
// scale and to the reference's own level. Both must be the same length.
export function compareSamples(reference, candidate) {
  if (reference.length !== candidate.length)
    throw new Error(`Length mismatch: ${reference.length} vs ${candidate.length}`);
  let sumReference = 0, sumError = 0, peakError = 0, peakReference = 0;
  for (let i = 0; i < reference.length; i++) {
    const r = reference[i], error = candidate[i] - r;
    sumReference += r * r;
    sumError += error * error;
    if (Math.abs(error) > peakError) peakError = Math.abs(error);
    if (Math.abs(r) > peakReference) peakReference = Math.abs(r);
  }
  const db = value => 20 * Math.log10(Math.max(value, 1e-12));
  const rmsReference = Math.sqrt(sumReference / reference.length);
  const rmsError = Math.sqrt(sumError / reference.length);
  return {
    samples: reference.length,
    rms_reference_dbfs: db(rmsReference),
    peak_reference_dbfs: db(peakReference),
    rms_error_dbfs: db(rmsError),
    peak_error_dbfs: db(peakError),
    // How far the error sits below the programme: the number that decides
    // whether a format change is audible.
    signal_to_error_db: db(rmsReference) - db(rmsError),
  };
}
