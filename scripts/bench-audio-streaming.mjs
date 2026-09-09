// Deterministic disk fixtures and repeated Release measurements. Never evicts
// the OS file cache; limited fill workers are not an Android emulation.
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { arch, cpus, platform, totalmem } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [benchArg, outArg, repeatArg = '3'] = process.argv.slice(2);
if (!benchArg || !outArg) throw new Error('Usage: node scripts/bench-audio-streaming.mjs BENCH NEW_OUTPUT_DIR [REPEATS=3]');
const repeats = Number(repeatArg);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('Invalid repetitions');
const bench = resolve(benchArg), out = resolve(outArg);
const sha = data => createHash('sha256').update(data).digest('hex');
const executableSha = sha(readFileSync(bench));
mkdirSync(out); // Refuse to overwrite a previous capture.
const fixtures = join(out, 'fixtures');
mkdirSync(fixtures);
const tracks = 12, seconds = 40, sr = 48000;
const files = [];
// One-second chunks bound fixture creation memory independently of duration.
for (let track = 0; track < tracks; track++) {
  const chunk = Buffer.alloc(sr * 4);
  for (let f = 0; f < sr; f++) {
    const value = Math.round(7000 * Math.sin(2 * Math.PI * (110 + track * 13) * f / sr));
    chunk.writeInt16LE(value, f * 4);
    chunk.writeInt16LE(value, f * 4 + 2);
  }
  const header = Buffer.alloc(44), dataBytes = chunk.length * seconds;
  header.write('RIFF'); header.writeUInt32LE(dataBytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  const path = join(fixtures, `${track}.wav`), hash = createHash('sha256');
  const fd = openSync(path, 'wx');
  try {
    for (const data of [header, ...Array(seconds).fill(chunk)]) {
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
      hash.update(data);
    }
  } finally { closeSync(fd); }
  files.push({ name: `${track}.wav`, bytes: dataBytes + 44, sha256: hash.digest('hex') });
}
const git = args => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git failed');
  return result.stdout.trim();
};
const metadata = {
  started_at: new Date().toISOString(), executable_sha256: executableSha,
  commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--short']),
  cpu: cpus()[0]?.model, logical_cpus: cpus().length, platform: platform(), architecture: arch(),
  total_memory_bytes: totalmem(), repeats, files, cache_mb: 64, read_ahead_blocks: 16,
  render_threads: 1, diagnostic_phases: false,
  limitations: 'Warm OS cache; native PCM16 WAV; normal director priority; no device, GUI, import or thermal emulation. Immediate seek bypasses jump gate. Cache and queues sampled every 16 callbacks.',
};
const rows = [];
for (let repetition = 0; repetition < repeats; repetition++) {
  const cases = [];
  for (const fillThreads of [1, 2]) for (const block of [128, 512])
    for (const trim of [0, 1]) for (const preload of [0, 1]) cases.push({ fillThreads, block, trim, preload });
  if (repetition % 2) cases.reverse();
  for (const cfg of cases) {
    const id = `r${repetition}-f${cfg.fillThreads}-b${cfg.block}-t${cfg.trim}-p${cfg.preload}`;
    console.log(id);
    const jsonPath = join(out, `${id}.json`);
    const result = spawnSync(bench, [fixtures, jsonPath, String(tracks), String(cfg.block), '512', String(cfg.preload), String(cfg.trim)], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, LIBRETRACKS_AUDIO_DIAG: '0', LIBRETRACKS_FILL_THREADS: String(cfg.fillThreads), LIBRETRACKS_SOURCE_CACHE_MB: '64', LIBRETRACKS_SOURCE_READ_AHEAD_BLOCKS: '16' },
    });
    writeFileSync(join(out, `${id}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.error || result.status !== 0) throw new Error(`${id}: ${result.error ?? result.stderr}`);
    const row = JSON.parse(readFileSync(jsonPath, 'utf8'));
    if (row.tracks !== tracks || row.blocks !== 512 || row.block !== cfg.block || row.preload !== cfg.preload || row.trim !== cfg.trim)
      throw new Error(`Unexpected configuration: ${id}`);
    rows.push({ repetition, fill_threads: cfg.fillThreads, ...row });
    writeFileSync(join(out, 'results.json'), JSON.stringify({ metadata, rows }, null, 2) + '\n');
  }
}
console.log(`Saved ${rows.length} runs to ${out}`);
