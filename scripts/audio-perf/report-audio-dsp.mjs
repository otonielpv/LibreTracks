import {readFileSync, writeFileSync} from 'node:fs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/report-audio-dsp.mjs results.json report.md');
const {metadata, rows} = JSON.parse(readFileSync(input, 'utf8'));
if (metadata.mode !== 'dsp') throw new Error('Expected DSP matrix');
const modes = ['Directo', 'Warp 1,2×', 'Tono +3 (varispeed)', 'Warp 1,2× y tono +3'];
const groups = new Map();
for (const row of rows) {
  const warp = row.dsp === 1 || row.dsp === 3;
  const expectedRatio = warp ? 1.2 : row.dsp === 2 ? 2 ** (3 / 12) : 1;
  if (![0, 1, 2, 3].includes(row.dsp) || ![128, 512].includes(row.block)
      || ![0, 4].includes(row.imports_requested) || row.fill_threads !== 1 || row.tracks !== 12
      || row.blocks !== 512 || row.rendered_tracks !== 6144 || row.command_seek !== 1 || row.prime_start !== 1
      || row.jump_applied_block < 0 || row.imports_completed !== row.imports_requested
      || (row.imports_requested && !row.import_overlap_blocks)
      || row.read_failures || row.open_failures || row.output_energy <= 0 || !Number.isFinite(row.p95_us)
      || Math.abs((row.source_ratio ?? row.warp_ratio) - expectedRatio) > .00001)
    throw new Error('Invalid DSP workload');
  if (warp ? (row.active_voices_start !== 12 || row.active_voices_end !== 12 || row.path_stretched !== 6144 || row.missing_voice_blocks || !row.stretched_output_frames)
      : (row.active_voices_start || row.active_voices_end || (row.dsp === 2 ? row.path_varispeed : row.path_direct) !== 6144))
    throw new Error('DSP path or voices not verified');
  const key = [row.block, row.imports_requested, row.dsp].join('/');
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
if (groups.size !== 16) throw new Error('Incomplete DSP matrix');
const median = values => {
  const sorted = [...values].sort((a,b) => a-b), n = sorted.length;
  return n % 2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2;
};
const lines = ['# DSP activo, salto protegido e importación', '',
  `${metadata.cpu}; Release; ${metadata.repeats} repeticiones; 12 pistas; 48 kHz; 512 bloques por pasada. Un trabajador de lectura, uno de decode y un hilo de render.`, '',
  'Medianas entre pasadas; p95/p99 no son percentiles agrupados. El arranque se prepara con SeekAbsolute en todas las variantes, incluido directo. ' +
  'La transposición sin warp usa varispeed: no se fuerza artificialmente Bungee.', '',
  '| Ruta | Buffer | Imports | p95 µs | p99 µs | Comando salto ms | CPU s | Pico MiB | Fallos lectura fuente (frames) | Bloques salida nula | Render tardío |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
const variable = [];
for (const group of groups.values()) {
  if (group.length !== metadata.repeats || new Set(group.map(r=>r.repetition)).size !== metadata.repeats)
    throw new Error('Missing or duplicate DSP repetitions');
  const row=group[0], m=key=>median(group.map(r=>r[key])), sum=key=>group.reduce((a,r)=>a+r[key],0);
  const p95s=group.map(r=>r.p95_us);
  if (Math.max(...p95s)/Math.min(...p95s)>1.5)
    variable.push(`${modes[row.dsp]}, buffer ${row.block}, imports ${row.imports_requested}`);
  lines.push(`| ${modes[row.dsp]} | ${row.block} | ${row.imports_requested} | ${m('p95_us').toFixed(1)} | ${m('p99_us').toFixed(1)} | ${m('command_seek_ms').toFixed(2)} | ${m('process_cpu_seconds').toFixed(3)} | ${(m('peak_rss_bytes')/1024**2).toFixed(1)} | ${sum('missing_source_frames')} | ${sum('zero_output_blocks')} | ${sum('deadline_misses')} |`);
}
if (variable.length) lines.push('', 'Casos cuyo p95 varió más de 1,5× entre repeticiones (señal descriptiva, no test temporal):', '', ...variable.map(v=>`- ${v}`));
lines.push('', 'Los fallos de lectura de fuente incluyen lecturas del DSP y de la preparación de voces durante playback; no equivalen a frames de salida ausentes. ' +
  'Salida nula significa que todo el bloque esté exactamente a cero: no descarta pérdidas parciales, clics o desalineación. La energía y los contadores de ruta no sustituyen una prueba de fidelidad.', '',
  'CPU s y pico residente se capturan hasta terminar playback. El pico incluye preparación inicial. Comparar CPU s sólo entre ventanas con el mismo buffer. ' +
  'Los saltos discontinuos pueden incrementar stretched_feed_gap_frames: no interpretar ese total como un fallo durante reproducción continua.', '',
  'Fuentes recién escritas, caché del SO caliente y 64 MiB de caché del motor forzados sobre un perfil de PC potente; no es una emulación Android. ' +
  'Sin dispositivo, UI ni validación térmica; no se activa el ajuste del working set de initialize(). El comando se mide sin JSON/IPC.', '',
  'Compatibilidad de datos: en la captura inicial DSP, warp_ratio contenía la razón de consumo de fuente, también para varispeed. ' +
  'Las capturas nuevas separan source_ratio y warp_ratio; warp_enabled identifica siempre si hay warp.', '',
  `Ejecutable SHA-256: ${metadata.executable_sha256}`, '');
writeFileSync(output, lines.join('\n'));
console.log(`Saved ${groups.size} DSP scenarios`);
