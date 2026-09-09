// Sequential Release measurements. Never run benchmarks alongside builds/tests.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { blocks: 256, repeats: 3 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!['bench', 'reference', 'out', 'blocks', 'repeats', 'threads', 'cases', 'parallel-threshold', 'diagnostics'].includes(key) || !process.argv[i + 1]) {
    throw new Error('Usage: node scripts/bench-audio-render.mjs --bench Release/bench_render_callback.exe --out bench-out/name [--blocks 256] [--repeats 3]');
  }
  options[key] = process.argv[i + 1];
}
for (const key of ['blocks', 'repeats']) {
  options[key] = Number(options[key]);
  if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`Invalid ${key}`);
}
if (!options.bench || !options.out) throw new Error('--bench and --out are required');
const executable = path.resolve(options.bench);
const threadCounts = (options.threads ?? '1,4').split(',').map(Number);
if (threadCounts.some(n => !Number.isInteger(n) || n < 1 || n > 8)
    || new Set(threadCounts).size !== threadCounts.length) throw new Error('Invalid --threads');
const diagnostics = String(options.diagnostics ?? '1');
if (!['0', '1'].includes(diagnostics)) throw new Error('Invalid --diagnostics');
if (options['parallel-threshold'] !== undefined) {
  options['parallel-threshold'] = Number(options['parallel-threshold']);
  if (!Number.isInteger(options['parallel-threshold']) || options['parallel-threshold'] < 1
      || options['parallel-threshold'] > 256) throw new Error('Invalid --parallel-threshold');
}
const output = path.resolve(options.out);
if (existsSync(output)) throw new Error(`Use a new output directory: ${output}`);
mkdirSync(output, { recursive: true });
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'git failed');
  return result.stdout.trim();
};
const metadata = {
  started_at: new Date().toISOString(), commit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--short'), executable,
  executable_sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  platform: os.platform(), os_release: os.release(), architecture: os.arch(),
  cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length,
  total_memory_bytes: os.totalmem(), free_memory_bytes_at_start: os.freemem(),
  blocks: options.blocks, repeats: options.repeats,
  workload: 'Synthetic resident stereo PCM, 48 kHz; no device, disk streaming or GUI',
  diagnostic_phases: diagnostics === '1',
  requested_threads: threadCounts,
  parallel_threshold_override: options['parallel-threshold'] ?? null,
};
writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
const scenarios = [
  { name: 'direct', tracks: 24, warp: 0, ratio: 1, muted: 0 },
  { name: 'neutral', tracks: 24, warp: 1, ratio: 1, muted: 0 },
  { name: 'warp-small', tracks: 4, warp: 1, ratio: 1.2, muted: 0 },
  { name: 'warp', tracks: 24, warp: 1, ratio: 1.2, muted: 0 },
  { name: 'muted', tracks: 24, warp: 1, ratio: 1.2, muted: 24 },
  { name: 'mostly-muted', tracks: 24, warp: 1, ratio: 1.2, muted: 20 },
];
const selected = options.cases?.split(',') ?? scenarios.map(s => s.name);
if (selected.some(name => !scenarios.some(s => s.name === name))) throw new Error('Invalid --cases');
const cases = scenarios.filter(s => selected.includes(s.name)).flatMap(scenario => [128, 512].flatMap(block =>
  threadCounts.map(threads => ({ ...scenario, block, threads }))));
const variants = [{ name: 'candidate', executable, metadata, rows: [], result: 'results.json' }];
if (options.reference) {
  const reference = path.resolve(options.reference);
  variants.push({ name: 'reference', executable: reference, rows: [], result: 'reference-results.json',
    metadata: { ...metadata, executable: reference,
      executable_sha256: createHash('sha256').update(readFileSync(reference)).digest('hex'),
      parallel_threshold_override: null,
    } });
}
for (let repeat = 0; repeat < options.repeats; ++repeat) {
  // Alternate order to reduce systematic warm-up / thermal order effects.
  for (const config of repeat % 2 ? [...cases].reverse() : cases) {
   for (const variant of repeat % 2 ? variants : [...variants].reverse()) {
    const label = `${variant.name}-${config.name}-b${config.block}-t${config.threads}-r${repeat + 1}`;
    const json = path.join(output, `${label}.json`);
    const args = ['--tracks', config.tracks, '--block', config.block,
      '--threads', config.threads, '--warp', config.warp, '--ratio', config.ratio,
      '--muted-tracks', config.muted, '--blocks', options.blocks, '--warmup', 150,
      '--paced', '--label', label, '--json', json].map(String);
    if (variant.name === 'candidate' && options['parallel-threshold'] !== undefined)
      args.push('--parallel-threshold', String(options['parallel-threshold']));
    const result = spawnSync(variant.executable, args, {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LIBRETRACKS_AUDIO_DIAG: diagnostics },
    });
    writeFileSync(path.join(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.status !== 0) throw new Error(`${label} failed: ${result.error ?? result.status}; see log`);
    const row = JSON.parse(readFileSync(json, 'utf8')).rows[0];
    if (!row || row.effective_threads !== config.threads || row.blocks !== options.blocks) {
      throw new Error(`${label}: configuration mismatch`);
    }
    variant.rows.push({ scenario: config.name, repeat: repeat + 1, ...row });
    console.log(`${label}: p95=${row.p95_us} us, p99=${row.p99_us} us, late=${row.deadline_misses}, parallel=${row.parallel_blocks}`);
    writeFileSync(path.join(output, variant.result), JSON.stringify({ metadata: variant.metadata, rows: variant.rows }, null, 2) + '\n');
   }
  }
}
for (const variant of variants) {
  variant.metadata.finished_at = new Date().toISOString();
  writeFileSync(path.join(output, variant.result), JSON.stringify({ metadata: variant.metadata, rows: variant.rows }, null, 2) + '\n');
}
console.log(`Saved ${variants.reduce((n, v) => n + v.rows.length, 0)} measurements in ${output}`);
