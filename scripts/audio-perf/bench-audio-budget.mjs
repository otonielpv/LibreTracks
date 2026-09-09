// What preparing warp and pitch actually costs, per format.
//
// Until now the cost of the prepared-audio strategy was a single data point
// (12 tracks of 40 s in float32) that everything else was extrapolated from.
// This measures it as a rate — MiB and seconds per track-minute — at two track
// counts so the linearity is checked rather than assumed, and it measures the
// same thing in 16-bit PCM, which halves the disk and is the only version that
// could plausibly fit a modest Android device.
//
// The quality question that decision raises is answered here too: the two
// prepared files come from the same render, so their difference IS the
// quantization noise, and it is reported against the programme level.
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { cpus, platform, arch, totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeFixture, SAMPLE_RATE } from './audio-fidelity-fixture.mjs';
import { readWav, compareSamples } from './audio-wav.mjs';
import { fileHash } from './audio-prepared-cache.mjs';

const [prepareArg, outArg, secondsArg = '240', repeatsArg = '2'] = process.argv.slice(2);
if (!outArg) throw new Error('Usage: node scripts/bench-audio-budget.mjs BENCH_PREPARE_WARP NEW_OUT [SECONDS=240] [REPEATS=2]');
const preparer = resolve(prepareArg), out = resolve(outArg);
const seconds = Number(secondsArg), repeats = Number(repeatsArg);
if (!Number.isInteger(seconds) || seconds < 8 || seconds > 600 || (seconds * SAMPLE_RATE) % 512)
  throw new Error('Length must be a whole number of 512-frame blocks (a multiple of 4 s)');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 6) throw new Error('Invalid repetitions');

const WARP_RATIO = 1.2, SEMITONES = 3, BLOCK = 512;
const TRACK_COUNTS = [1, 4];          // Two points, to check the cost is linear.
const FORMATS = ['float32', 'pcm16'];
const MAX_TRACKS = Math.max(...TRACK_COUNTS);
// The source has to outlast the timeline at the warp ratio, plus the DSP's own
// read-ahead. Rounded up to whole seconds.
const SOURCE_SECONDS = Math.ceil(seconds * WARP_RATIO) + 2;

mkdirSync(out);
const fixtures = join(out, 'fixtures');
mkdirSync(fixtures);
console.log(`Writing ${MAX_TRACKS} fixtures of ${SOURCE_SECONDS} s`);
const fixtureInfo = [];
for (let track = 0; track < MAX_TRACKS; track++)
  fixtureInfo.push({ name: `${track}.wav`, ...writeFixture(join(fixtures, `${track}.wav`), { seconds: SOURCE_SECONDS, track }) });

const git = args => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git failed');
  return result.stdout.trim();
};
const metadata = {
  mode: 'budget', started_at: new Date().toISOString(),
  timeline_seconds: seconds, source_seconds: SOURCE_SECONDS, block: BLOCK,
  warp_ratio: WARP_RATIO, semitones: SEMITONES, sample_rate: SAMPLE_RATE,
  track_counts: TRACK_COUNTS, formats: FORMATS, repeats, fixtures: fixtureInfo,
  cpu: cpus()[0]?.model, logical_cpus: cpus().length,
  platform: platform(), architecture: arch(), ram_bytes: totalmem(),
  commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--short']),
  preparer_sha256: fileHash(preparer),
  bungee_sha256: platform() === 'win32' ? fileHash(join(dirname(preparer), 'bungee.dll')) : null,
};

const env = {
  ...process.env, LIBRETRACKS_AUDIO_DIAG: '0', LIBRETRACKS_SOURCE_CACHE_MB: '256',
  LIBRETRACKS_FILL_THREADS: '1', LIBRETRACKS_STREAMING_DECODE: '1',
  LIBRETRACKS_SOURCE_READ_AHEAD_BLOCKS: '16', LIBRETRACKS_SOURCE_EAGER_BLOCKS: '64',
  LIBRETRACKS_DECODE_GATE: '0', LIBRETRACKS_CACHE_FLOAT: '0',
};

const runs = [];
for (let repetition = 0; repetition < repeats; repetition++) {
  // Reversed on odd repetitions, the same way the A/B runners alternate
  // reference and candidate. The first preparation of a batch reads a file the
  // fixture writer has just left hot in the OS cache, and without alternating
  // that warm-up is indistinguishable from a real difference between formats.
  const cases = [];
  for (const tracks of TRACK_COUNTS) for (const format of FORMATS) cases.push({ tracks, format });
  if (repetition % 2) cases.reverse();
  for (const { tracks, format } of cases) {
    const id = `r${repetition}-t${tracks}-${format}`;
    const directory = join(out, id);
    console.log(`Preparing ${tracks} track(s) of ${seconds} s in ${format} (repetition ${repetition})`);
    const started = performance.now();
    const result = spawnSync(preparer,
      [fixtures, directory, String(tracks), String(BLOCK), String(seconds), String(WARP_RATIO), String(SEMITONES), format],
      { encoding: 'utf8', env, timeout: 1800000 });
    const wall_ms = performance.now() - started;
    writeFileSync(join(out, `${id}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.error || result.status !== 0) throw new Error(result.error ?? result.stderr ?? 'preparation failed');
    const stats = JSON.parse(readFileSync(join(directory, 'preparation.json'), 'utf8'));
    if (stats.format !== format || stats.tracks !== tracks || stats.seconds !== seconds
      || stats.samples_verified !== tracks * seconds * SAMPLE_RATE * 2)
      throw new Error('Preparation did not verify every sample it claimed to write');
    // Measured, not the preparer's own arithmetic: the file on disk is the cost.
    let bytes = 0;
    for (let track = 0; track < tracks; track++) bytes += statSync(join(directory, `${track}.wav`)).size;
    const trackMinutes = (tracks * seconds) / 60;
    runs.push({
      repetition, order: cases.findIndex(c => c.tracks === tracks && c.format === format),
      tracks, format, wall_ms, bytes, track_minutes: trackMinutes,
      mib_per_track_minute: bytes / 1024 ** 2 / trackMinutes,
      prepare_s_per_track_minute: stats.prepare_ms / 1000 / trackMinutes,
      verify_s_per_track_minute: stats.verify_ms / 1000 / trackMinutes,
      realtime_factor: (tracks * seconds) / (stats.prepare_ms / 1000),
      ...stats,
    });
    writeFileSync(join(out, 'results.json'), JSON.stringify({ metadata, runs, quality: null }, null, 2) + '\n');
  }
}

// The two formats come from the same deterministic render, so whatever differs
// between them is exactly what 16 bits cost.
console.log('Measuring the quantization difference between the two formats');
const quality = [];
for (let track = 0; track < MAX_TRACKS; track++) {
  const reference = readWav(join(out, `r0-t${MAX_TRACKS}-float32`, `${track}.wav`));
  const candidate = readWav(join(out, `r0-t${MAX_TRACKS}-pcm16`, `${track}.wav`));
  if (reference.frames !== candidate.frames || reference.channels !== candidate.channels)
    throw new Error(`The two formats do not describe the same audio for track ${track}`);
  quality.push({ track, ...compareSamples(reference.samples, candidate.samples) });
}
writeFileSync(join(out, 'results.json'), JSON.stringify({ metadata, runs, quality }, null, 2) + '\n');
for (const q of quality)
  console.log(`track ${q.track}: programme ${q.rms_reference_dbfs.toFixed(1)} dBFS, `
    + `quantization error ${q.rms_error_dbfs.toFixed(1)} dBFS, ${q.signal_to_error_db.toFixed(1)} dB below it`);
console.log(`Saved ${runs.length} preparations to ${join(out, 'results.json')}`);
