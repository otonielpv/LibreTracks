import { readFileSync, writeFileSync } from 'node:fs';

const [beforePath, afterPath, reportPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !reportPath) {
  throw new Error('Usage: node scripts/compare-audio-render.mjs before/results.json after/results.json report.md');
}
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));
for (const key of ['cpu', 'platform', 'architecture', 'logical_cpus', 'blocks', 'repeats', 'diagnostic_phases']) {
  if (before.metadata[key] !== after.metadata[key]) throw new Error(`Not comparable: ${key}`);
}
const keyFor = row => JSON.stringify([row.scenario, row.tracks, row.block, row.sample_rate,
  row.warp, row.ratio, row.semitones, row.muted_tracks, row.threads, row.paced]);
const groups = rows => {
  const result = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
};
const a = groups(before.rows), b = groups(after.rows);
if (a.size !== b.size) throw new Error('Different scenario sets');
const median = values => {
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const med = (rows, field) => median(rows.map(row => row[field]));
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
const f = number => number.toFixed(1);
const variableCases = [];
const lines = [
  `Release render comparison — ${after.metadata.cpu}`, '',
  `${after.metadata.repeats} repetitions of ${after.metadata.blocks} measured blocks per case. ` +
    'Values are medians across runs; p99 is not a pooled percentile.', '',
  'Resident synthetic PCM, paced callbacks. No audio device, streaming disk workload or GUI. ' +
    'The director uses normal thread priority; workers use engine priority promotion. ' +
    'Do not extrapolate these results to other hardware or interpret late renders as measured driver xruns.', '',
  '| Case | Buffer | Threads | p95 before → after (µs) | Change | p99 before → after (µs) | Late blocks before → after | Process CPU before → after |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
];
for (const [key, oldRows] of a) {
  const newRows = b.get(key);
  if (!newRows || oldRows.length !== before.metadata.repeats || newRows.length !== after.metadata.repeats) {
    throw new Error(`Missing repetitions for ${key}`);
  }
  for (const field of ['rendered_tracks', 'skipped_tracks', 'path_direct', 'path_varispeed', 'path_stretched', 'bungee_voices']) {
    const values = [...oldRows, ...newRows].map(row => row[field]);
    if (values.some(value => value !== values[0])) throw new Error(`Workload changed: ${field} in ${key}`);
  }
  const row = oldRows[0];
  const spread = rows => {
    const values = rows.map(value => value.p95_us);
    return Math.max(...values) / Math.min(...values);
  };
  if (spread(oldRows) > 1.5 || spread(newRows) > 1.5) {
    variableCases.push(`${row.scenario}, buffer ${row.block}, ${row.threads} threads`);
  }
  const old95 = med(oldRows, 'p95_us'), new95 = med(newRows, 'p95_us');
  lines.push(`| ${row.scenario} | ${row.block} | ${row.threads} | ${f(old95)} → ${f(new95)} | ` +
    `${f((new95 / old95 - 1) * 100)}% | ${f(med(oldRows, 'p99_us'))} → ${f(med(newRows, 'p99_us'))} | ` +
    `${sum(oldRows, 'deadline_misses')} → ${sum(newRows, 'deadline_misses')} | ` +
    `${med(oldRows, 'process_cpu_percent').toFixed(3)}% → ${med(newRows, 'process_cpu_percent').toFixed(3)}% |`);
}
if (variableCases.length) {
  lines.push('', 'Cases where p95 varies by more than 1.5× between repetitions in at least one variant ' +
    '(descriptive variability flag, not a timing test):', '', ...variableCases.map(value => `- ${value}`));
}
lines.push('', 'Process CPU is normalized across all logical CPUs and includes benchmark bookkeeping and pacing. ' +
  'It is not the audio deadline load.', '',
  `Before executable SHA-256: ${before.metadata.executable_sha256}`, '',
  `After executable SHA-256: ${after.metadata.executable_sha256}`, '');
writeFileSync(reportPath, lines.join('\n'));
console.log(lines.join('\n'));
