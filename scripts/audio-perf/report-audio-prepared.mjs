import {readFileSync, writeFileSync} from 'node:fs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/report-audio-prepared.mjs results.json report.md');
const {metadata, preparations, rows} = JSON.parse(readFileSync(input, 'utf8'));
if (metadata.mode !== 'prepared' || !Number.isInteger(metadata.repeats) || metadata.repeats < 1)
  throw new Error('Expected prepared matrix');
if (preparations.length !== 2 || new Set(preparations.map(p=>p.block)).size !== 2)
  throw new Error('Incomplete preparations');
const lines = ['# Prototipo de audio preparado', '',
  `${metadata.cpu}; Release; 12 pistas, warp 1,2 y tono +3; ${metadata.repeats} repeticiones por caso.`, '',
  'Preparación secuencial por pista, WAV float32 estéreo a 48 kHz. Verificación bit a bit contra un segundo render continuo desde cero; no demuestra equivalencia de saltos arbitrarios.', '',
  '| Buffer | Preparación s | Verificación s | Pico MiB | Disco MiB | Muestras verificadas |',
  '| ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const p of preparations) {
  if (![128,512].includes(p.block) || p.tracks !== 12 || p.seconds !== 40 || p.ratio !== 1.2 || p.semitones !== 3
      || p.samples_verified !== 46080000 || p.output_bytes !== 184320528 || !(p.energy > 0))
    throw new Error('Preparation verification failed');
  lines.push(`| ${p.block} | ${(p.prepare_ms/1000).toFixed(2)} | ${(p.verify_ms/1000).toFixed(2)} | ${(p.peak_rss_bytes/1024**2).toFixed(1)} | ${(p.output_bytes/1024**2).toFixed(1)} | ${p.samples_verified} |`);
}
const groups = new Map();
for (const r of rows) {
  if (![0,1].includes(r.prepared) || ![128,512].includes(r.block) || ![0,4].includes(r.imports_requested)
      || r.tracks !== 12 || r.blocks !== 512 || r.sample_rate !== 48000 || r.rendered_tracks !== 6144
      || r.command_seek !== 1 || r.prime_start !== 1 || r.preload !== 1 || r.trim !== 0
      || r.imports_completed !== r.imports_requested || (r.imports_requested && !r.import_overlap_blocks)
      || r.jump_applied_block < 0 || r.read_failures || r.open_failures || r.missing_voice_blocks
      || !(r.output_energy > 0) || !Number.isFinite(r.p95_us)
      || !Number.isInteger(r.repetition) || r.repetition < 0 || r.repetition >= metadata.repeats)
    throw new Error('Invalid playback workload');
  if (r.prepared ? (r.dsp !== 0 || r.active_voices_start || r.active_voices_end || r.path_direct !== 6144)
    : (r.dsp !== 3 || r.active_voices_start !== 12 || r.active_voices_end !== 12 || r.path_stretched !== 6144
       || r.warp_ratio !== 1.2 || r.semitones !== 3)) throw new Error('Unexpected DSP route');
  const key = `${r.block}/${r.imports_requested}/${r.prepared}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
if (groups.size !== 8) throw new Error('Incomplete playback matrix');
const median = xs => { const s=[...xs].sort((a,b)=>a-b), n=s.length; return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; };
lines.push('', 'Medianas entre pasadas; p95/p99 no son percentiles agrupados. Fallos de lectura, bloques nulos y renders tardíos son sumas de las repeticiones.', '',
  '| Ruta | Buffer | Imports | p95 µs | p99 µs | Salto ms | CPU s | Pico MiB | Validar caché ms | Fallos fuente frames | Salida nula | Render tardío |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
const variable=[];
for (const [key, group] of groups) {
  if (group.length !== metadata.repeats || new Set(group.map(r=>r.repetition)).size !== metadata.repeats)
    throw new Error('Missing or duplicate repetitions');
  const r=group[0], m=k=>median(group.map(r=>r[k])), sum=k=>group.reduce((a,r)=>a+r[k],0);
  if (Math.max(...group.map(r=>r.p95_us))/Math.min(...group.map(r=>r.p95_us)) > 1.5) variable.push(key);
  lines.push(`| ${r.prepared?'Preparado':'DSP vivo'} | ${r.block} | ${r.imports_requested} | ${m('p95_us').toFixed(1)} | ${m('p99_us').toFixed(1)} | ${m('command_seek_ms').toFixed(2)} | ${m('process_cpu_seconds').toFixed(3)} | ${(m('peak_rss_bytes')/1024**2).toFixed(1)} | ${m('validation_ms').toFixed(1)} | ${sum('missing_source_frames')} | ${sum('zero_output_blocks')} | ${sum('deadline_misses')} |`);
}
if (variable.length) lines.push('', `p95 con dispersión mayor de 1,5× entre repeticiones (buffer/imports/preparado): ${variable.join(', ')}.`);
lines.push('',
  'CPU y pico residente de playback excluyen el proceso preparador y la validación SHA-256. El pico preparador incluye su verificación. Cada preparación se midió una sola vez; las repeticiones corresponden al playback. Comparar CPU sólo dentro del mismo buffer.', '',
  'Se valida el contenido de todos los archivos preparados antes de cada pasada; esto calienta la caché del SO. La referencia también usa archivos recientemente leídos, pero no hay igualdad demostrada de residencia. Original PCM16 frente a candidato float32: se compara la estrategia completa, incluido su coste de formato y almacenamiento.', '',
  'Los fallos de fuente incluyen preparación de voces y no equivalen a frames de salida perdidos. Salida nula sólo detecta bloques exactamente a cero. Los renders tardíos superan la duración del buffer; no son xruns medidos en un dispositivo.', '',
  'Un hilo de render, uno de lectura y uno de decode; caché del motor de 64 MiB. Banco sin dispositivo ni UI sobre PC potente: no es una emulación de Android ni una prueba térmica sostenida.', '',
  `Ejecutable SHA-256: ${metadata.executable_sha256}`, '', `Preparador SHA-256: ${metadata.preparer_sha256}`, '');
writeFileSync(output, lines.join('\n'));
console.log(`Saved ${groups.size} prepared scenarios`);
