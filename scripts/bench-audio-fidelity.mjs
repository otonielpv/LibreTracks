// Captures the live warp/pitch route and the prepared-audio route around the
// four transport events a musician actually performs — start, jump forward,
// jump back, resume — and compares them.
//
// This is the gate the prepared-audio prototype has not passed yet: the
// existing verification only proves that a continuous render from frame 0
// survives a disk round trip bit for bit. It says nothing about what the live
// DSP produces after it rebuilds its voices at a seek target, which is what a
// prepared file would have to replace.
//
// Nothing here is an application feature. The prepared file is produced by
// bench_prepare_warp, outside the engine and outside the UI.
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { cpus, platform, arch, totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeFixture, SAMPLE_RATE } from './audio-fidelity-fixture.mjs';
import { compareRoutes } from './audio-fidelity-analysis.mjs';
import { fileHash } from './audio-prepared-cache.mjs';

const [captureArg, prepareArg, outArg, repeatsArg = '3'] = process.argv.slice(2);
if (!outArg) throw new Error(
  'Usage: node scripts/bench-audio-fidelity.mjs BENCH_FIDELITY_JUMP BENCH_PREPARE_WARP NEW_OUT [REPEATS=3]');
const capture = resolve(captureArg), preparer = resolve(prepareArg), out = resolve(outArg);
const repeats = Number(repeatsArg);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Invalid repetitions');

// 48 s of timeline is divisible by both block sizes; the source has to outlast
// it at the warp ratio, with the DSP's own read-ahead on top.
const TIMELINE_SECONDS = 48, SOURCE_SECONDS = 90, WARP_RATIO = 1.2, SEMITONES = 3;
const BLOCKS = [128, 512], SCENARIOS = ['start', 'forward', 'backward', 'resume'], ROUTES = ['live', 'prepared'];
if ((TIMELINE_SECONDS * SAMPLE_RATE) % Math.max(...BLOCKS))
  throw new Error('Timeline length must be a whole number of blocks');

mkdirSync(out); // Refuse to overwrite a previous capture.
const fixtures = join(out, 'fixtures');
mkdirSync(fixtures);
const fixture = writeFixture(join(fixtures, '0.wav'), { seconds: SOURCE_SECONDS, track: 0 });

const git = args => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git failed');
  return result.stdout.trim();
};
const metadata = {
  mode: 'fidelity', started_at: new Date().toISOString(), repeats,
  timeline_seconds: TIMELINE_SECONDS, source_seconds: SOURCE_SECONDS,
  warp_ratio: WARP_RATIO, semitones: SEMITONES, sample_rate: SAMPLE_RATE,
  fixture, cpu: cpus()[0]?.model, logical_cpus: cpus().length,
  platform: platform(), architecture: arch(), ram_bytes: totalmem(),
  commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--short']),
  capture_sha256: fileHash(capture), preparer_sha256: fileHash(preparer),
  bungee_sha256: platform() === 'win32' ? fileHash(join(dirname(preparer), 'bungee.dll')) : null,
};

// Disk is out of the experiment: the bench makes the whole source resident and
// aborts on any cache miss, so the cache has to be able to hold it.
const env = {
  ...process.env, LIBRETRACKS_AUDIO_DIAG: '0', LIBRETRACKS_SOURCE_CACHE_MB: '512',
  LIBRETRACKS_FILL_THREADS: '2', LIBRETRACKS_STREAMING_DECODE: '1',
  LIBRETRACKS_SOURCE_READ_AHEAD_BLOCKS: '16', LIBRETRACKS_SOURCE_EAGER_BLOCKS: '64',
  LIBRETRACKS_DECODE_GATE: '0', LIBRETRACKS_CACHE_FLOAT: '0',
};

const run = (exe, args, log) => {
  const result = spawnSync(exe, args, { encoding: 'utf8', env, timeout: 600000 });
  writeFileSync(join(out, log), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.status !== 0) throw new Error(result.error ?? result.stderr ?? 'bench failed');
  return result.stdout;
};

const preparations = [];
for (const block of BLOCKS) {
  const directory = join(out, `prepared-${block}`);
  console.log(`Preparing and verifying block ${block}`);
  run(preparer, [fixtures, directory, '1', String(block), String(TIMELINE_SECONDS),
    String(WARP_RATIO), String(SEMITONES)], `prepare-${block}.log`);
  const stats = JSON.parse(readFileSync(join(directory, 'preparation.json'), 'utf8'));
  if (stats.samples_verified !== TIMELINE_SECONDS * SAMPLE_RATE * 2)
    throw new Error('Preparation did not verify every sample of the continuous render');
  preparations.push({ ...stats, sha256: fileHash(join(directory, '0.wav')),
    bytes: statSync(join(directory, '0.wav')).size });
}

const readCapture = path => {
  const raw = readFileSync(path);
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
};

function writeWav(path, samples, channels = 2) {
  const dataBytes = samples.length * 4;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(dataBytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, dataBytes)]));
}

const rows = [];
for (let repetition = 0; repetition < repeats; repetition++) {
  for (const block of BLOCKS) {
    for (const scenario of SCENARIOS) {
      const directory = join(out, `r${repetition}-b${block}-${scenario}`);
      mkdirSync(directory);
      const captured = {};
      for (const route of ROUTES) {
        const source = route === 'live' ? fixtures : join(out, `prepared-${block}`);
        run(capture, [source, directory, String(block), route, scenario,
          String(WARP_RATIO), String(SEMITONES), String(TIMELINE_SECONDS)],
          `r${repetition}-b${block}-${scenario}-${route}.log`);
        const stem = `${route}-${scenario}-b${block}`;
        captured[route] = {
          meta: JSON.parse(readFileSync(join(directory, `${stem}.json`), 'utf8')),
          samples: readCapture(join(directory, `${stem}.f32`)),
          sha256: fileHash(join(directory, `${stem}.f32`)),
        };
      }
      const live = captured.live, prepared = captured.prepared;
      // Both routes must have walked the same timeline, or the comparison is
      // between two different moments and every number below is meaningless.
      const sameTimeline = live.meta.timeline_frames.length === prepared.meta.timeline_frames.length
        && live.meta.timeline_frames.every((v, i) => v === prepared.meta.timeline_frames[i]);
      const eventFrame = live.meta.event_block * block;
      const metrics = sameTimeline ? compareRoutes({
        live: live.samples, prepared: prepared.samples, sampleRate: SAMPLE_RATE,
        eventFrame, settleSeconds: 4,
      }) : null;
      rows.push({
        repetition, block, scenario, event_frame: eventFrame,
        same_timeline: sameTimeline,
        live: { ...live.meta, timeline_frames: undefined, sha256: live.sha256 },
        prepared: { ...prepared.meta, timeline_frames: undefined, sha256: prepared.sha256 },
        metrics,
      });
      // Audible examples for the differences the numbers cannot settle. One
      // buffer size is enough; the WAVs are for listening, not for measuring.
      if (repetition === 0 && block === 512) {
        const from = eventFrame * 2, to = Math.min(live.samples.length, from + 4 * SAMPLE_RATE * 2);
        const a = live.samples.subarray(from, to), b = prepared.samples.subarray(from, to);
        const difference = Float32Array.from(a, (v, i) => v - b[i]);
        writeWav(join(directory, `example-${scenario}-live.wav`), a);
        writeWav(join(directory, `example-${scenario}-prepared.wav`), b);
        writeWav(join(directory, `example-${scenario}-difference.wav`), difference);
      }
      console.log(`r${repetition} b${block} ${scenario}: lag=${metrics?.alignment.lag_ms?.toFixed(2)} ms `
        + `median=${metrics?.envelope_error.median_db?.toFixed(2)} dB recovery=${metrics?.recovery_ms} ms`);
      writeFileSync(join(out, 'results.json'), JSON.stringify({ metadata, preparations, rows }, null, 2) + '\n');
    }
  }
}
console.log(`Saved ${rows.length} comparisons to ${join(out, 'results.json')}`);
