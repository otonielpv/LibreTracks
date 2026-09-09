import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/report-audio-streaming.mjs results.json report.md');
const { metadata, rows } = JSON.parse(readFileSync(input, 'utf8'));
const withJumps = metadata.mode === 'jump';
const withImports = metadata.mode === 'import' || withJumps;
const groups = new Map();
for (const row of rows) {
  const key = [row.fill_threads, row.block, row.trim, row.preload, row.imports_requested ?? 0, row.command_seek ?? 0].join('/');
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
if (groups.size !== (withImports && !withJumps ? 8 : 16)) throw new Error('Incomplete scenario set');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const lines = [
  withJumps ? '# Salto inmediato frente al comando protegido' : withImports ? '# Streaming con importación concurrente' : '# Streaming desde archivos: línea base', '',
  `${metadata.cpu}; Release; ${metadata.repeats} repeticiones; 12 pistas WAV PCM16 estéreo a 48 kHz; 512 bloques por pasada.`, '',
  'Cada pasada arranca en el segundo 5 y solicita un salto al segundo 30 a mitad de la ventana. ' +
    'La precarga cubre únicamente el arranque. Trim invoca la liberación de caché antes del salto; no simula toda la presión de memoria del sistema.', '',
  'Las cifras temporales son medianas de percentiles por pasada. Los frames ausentes se suman sobre fuentes y repeticiones; no son duración de silencio del máster ni xruns del driver. ' +
    'La memoria del proceso es su máximo residente desde el arranque, incluida preparación; la caché se muestrea cada 16 callbacks.', '',
  '| Fill workers | Buffer | Trim | Precarga | Preparación ms | p95 µs | p99 µs | Frames ausentes inicio / salto | Render tardío | Pico proceso MiB | CPU s |' + (withImports ? ' Importaciones | Import ms | Bloques con importación activa (suma) |' : '') + (withJumps ? ' Comando protegido | Comando ms |' : ''),
  '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |' + (withImports ? ' ---: | ---: | ---: |' : '') + (withJumps ? ' ---: | ---: |' : ''),
];
for (const group of groups.values()) {
  if (group.length !== metadata.repeats || new Set(group.map(row => row.repetition)).size !== metadata.repeats)
    throw new Error('Missing or duplicate repetitions');
  if (group.some(row => row.blocks !== 512 || row.tracks !== 12 || row.sample_rate !== 48000
      || row.rendered_tracks !== 12 * 512 || row.cache_capacity_bytes !== metadata.cache_mb * 1024 ** 2
      || !Number.isFinite(row.p95_us) || row.output_energy <= 0 || row.read_failures || row.open_failures))
    throw new Error('Invalid workload or measurement');
  const m = field => median(group.map(row => row[field]));
  const sum = field => group.reduce((total, row) => total + row[field], 0);
  const row = group[0];
  if (withImports && group.some(r => ![0, 4].includes(r.imports_requested) || r.imports_completed !== r.imports_requested
      || (r.imports_requested && !r.import_overlap_blocks))) throw new Error('Invalid import workload');
  if (withJumps && group.some(r => ![0, 1].includes(r.command_seek) || r.jump_applied_block < 0
      || !Number.isFinite(r.command_seek_ms))) throw new Error('Invalid jump workload');
  lines.push(`| ${row.fill_threads} | ${row.block} | ${row.trim} | ${row.preload} | ${m('prepare_ms').toFixed(2)} | ` +
    `${m('p95_us').toFixed(1)} | ${m('p99_us').toFixed(1)} | ${sum('missing_before_jump')} / ${sum('missing_after_jump')} | ` +
    `${sum('deadline_misses')} | ${(m('peak_rss_bytes') / 1024 ** 2).toFixed(1)} | ${m('process_cpu_seconds').toFixed(3)} |` +
    (withImports ? ` ${row.imports_requested} | ${m('import_ms').toFixed(1)} | ${sum('import_overlap_blocks')} |` : '') +
    (withJumps ? ` ${row.command_seek} | ${m('command_seek_ms').toFixed(2)} |` : ''));
}
lines.push('', 'CPU s mide tiempo total del proceso durante la ventana, incluyendo lecturas y muestreo. ' +
  'Los buffers diferentes implican ventanas de distinta duración; comparar CPU s únicamente entre ventanas iguales.', '',
  'En Windows el contador de CPU tiene resolución gruesa frente a estas ventanas cortas: un valor 0 no demuestra consumo nulo. Para evaluar ahorro sostenido hacen falta ventanas mayores.', '',
  'Límites: archivos recién escritos y caché del SO caliente, un solo hilo de render a prioridad normal, sin dispositivo de audio, ' +
  'interfaz ni validación térmica. ' + (withJumps ? 'Comando=1 ejecuta SeekAbsolute real en un hilo de control mientras continúa render; comando=0 cambia el reloj directamente. ' : 'El salto evita deliberadamente la espera de la capa de comandos de producción. ') +
  'Uno o dos trabajadores del i7 no equivalen a un móvil Android.', '',
  `Ejecutable SHA-256: ${metadata.executable_sha256}`, '',
  `Commit del entorno: ${metadata.commit}; el JSON incluye los cambios locales y hashes de los archivos de audio.`, '');
if (withImports) lines.push('Importación: cuatro WAV PCM16 a 44,1 kHz mediante SourcePreparationQueue y un DecodeWorkerPool de un trabajador, con caché nueva por pasada. ' +
  'La importación se solicita un callback antes del salto. El número de bloques activos mide solapamiento con el trabajo de preparación, incluyendo cola y esperas. ' +
  'Import ms incluye envío, decode/resample, escritura de caché y finalización; puede extenderse más allá de playback. ' +
  'CPU y pico residente de la tabla se capturan al terminar playback; el JSON conserva también el pico después de completar importación. No se añaden las pistas importadas a la mezcla.', '');
writeFileSync(output, lines.join('\n'));
console.log(`Saved ${groups.size} scenarios to ${output}`);
