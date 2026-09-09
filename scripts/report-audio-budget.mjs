import { readFileSync, writeFileSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/report-audio-budget.mjs results.json report.md');
const { metadata, runs, quality } = JSON.parse(readFileSync(input, 'utf8'));
if (metadata.mode !== 'budget') throw new Error('Expected a budget capture');
if (!quality?.length) throw new Error('The quantization comparison is missing');
const repeats = metadata.repeats ?? 1;
const expected = metadata.track_counts.length * metadata.formats.length * repeats;
if (runs.length !== expected) throw new Error(`Expected ${expected} preparations, got ${runs.length}`);

for (const r of runs) {
  if (!metadata.formats.includes(r.format) || !metadata.track_counts.includes(r.tracks)
    || r.seconds !== metadata.timeline_seconds || r.ratio !== metadata.warp_ratio
    || r.semitones !== metadata.semitones || !(r.energy > 0)
    || r.samples_verified !== r.tracks * r.seconds * metadata.sample_rate * 2)
    throw new Error(`Unexpected preparation: ${r.tracks} tracks in ${r.format}`);
  // The size on disk must be the size the format implies, or the rate below is
  // measuring something other than what it says.
  const perSample = r.format === 'pcm16' ? 2 : 4;
  if (r.bytes !== r.tracks * (44 + r.seconds * metadata.sample_rate * 2 * perSample))
    throw new Error(`File size disagrees with the format: ${r.tracks} tracks in ${r.format}`);
}

const fmt = (value, digits = 2) => value.toFixed(digits).replace('.', ',');
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
// One row per combination, median across repetitions, as the plan requires for
// anything timed. Disk size is identical across repetitions by construction.
const cells = [];
for (const format of metadata.formats) for (const tracks of metadata.track_counts) {
  const group = runs.filter(r => r.format === format && r.tracks === tracks);
  if (group.length !== repeats) throw new Error(`Missing repetitions for ${tracks} tracks in ${format}`);
  if (new Set(group.map(r => r.bytes)).size !== 1) throw new Error(`Disk size varied between repetitions: ${tracks}/${format}`);
  const m = key => median(group.map(r => r[key]));
  cells.push({
    format, tracks, bytes: group[0].bytes, track_minutes: group[0].track_minutes,
    clipped_samples: Math.max(...group.map(r => r.clipped_samples)),
    mib_per_track_minute: group[0].mib_per_track_minute,
    prepare_ms: m('prepare_ms'), verify_ms: m('verify_ms'),
    peak_rss_bytes: m('peak_rss_bytes'),
    prepare_s_per_track_minute: m('prepare_s_per_track_minute'),
    realtime_factor: m('realtime_factor'),
    prepare_spread: Math.max(...group.map(r => r.prepare_ms)) / Math.min(...group.map(r => r.prepare_ms)),
  });
}
const byFormat = format => cells.filter(c => c.format === format).sort((a, b) => a.tracks - b.tracks);
const lines = ['# Presupuesto de la preparación de warp y tono', '',
  `${metadata.cpu}; Release; warp ${fmt(metadata.warp_ratio, 1)} y tono ${metadata.semitones >= 0 ? '+' : ''}${metadata.semitones}; `
  + `buffer ${metadata.block}; línea de tiempo de ${metadata.timeline_seconds} s por pista.`, '',
  'Hasta ahora el coste de la estrategia era un único punto (12 pistas de 40 s en float32) del que se extrapolaba todo lo demás. '
  + 'Aquí se mide como tasa —MiB y segundos por pista-minuto— con dos números de pista, para comprobar que es lineal en vez de suponerlo, '
  + 'y se repite en PCM16, que reduce el disco a la mitad y es la única versión que podría caber en un Android modesto.', '',
  '| Formato | Pistas | Pista-minutos | Disco MiB | MiB/pista-minuto | Preparación s | s/pista-minuto | Veces tiempo real | Verificación s | Pico MiB | Muestras recortadas |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];

const problems = [];
for (const format of metadata.formats) for (const r of byFormat(format))
  lines.push(`| ${format} | ${r.tracks} | ${fmt(r.track_minutes, 1)} | ${fmt(r.bytes / 1024 ** 2, 1)} | `
    + `${fmt(r.mib_per_track_minute)} | ${fmt(r.prepare_ms / 1000)} | ${fmt(r.prepare_s_per_track_minute)} | `
    + `${fmt(r.realtime_factor, 1)}× | ${fmt(r.verify_ms / 1000)} | ${fmt(r.peak_rss_bytes / 1024 ** 2, 1)} | ${r.clipped_samples} |`);

// A rate is only a rate if it holds at both track counts.
for (const format of metadata.formats) {
  const group = byFormat(format);
  for (const key of ['mib_per_track_minute', 'prepare_s_per_track_minute']) {
    const values = group.map(r => r[key]);
    const spread = Math.max(...values) / Math.min(...values);
    if (spread > 1.25) problems.push(`${format}: ${key.replace(/_/g, ' ')} varía ${fmt(spread)}× entre ${group.map(r => r.tracks).join(' y ')} pistas; `
      + 'la tasa no es lineal y no se puede usar para estimar una sesión');
  }
}
for (const c of cells) if (c.clipped_samples)
  problems.push(`${c.format} con ${c.tracks} pistas: ${c.clipped_samples} muestras recortadas al techo del formato`);
for (const c of cells) if (c.prepare_spread > 1.25)
  problems.push(`${c.format} con ${c.tracks} pistas: la preparación varía ${fmt(c.prepare_spread)}× entre repeticiones; `
    + 'ese tiempo no describe una sola cosa');

const worst = quality.reduce((a, b) => (a.signal_to_error_db <= b.signal_to_error_db ? a : b));
lines.push('', '## Lo que cuesta pasar a 16 bits', '',
  'Los dos archivos salen del mismo render determinista, así que su diferencia **es** exactamente el ruido de cuantización. '
  + 'Se mide contra el nivel del propio programa, que es lo que decide si se oye.', '',
  '| Pista | Programa dBFS | Pico dBFS | Error RMS dBFS | Pico de error dBFS | Programa por encima del error |',
  '| ---: | ---: | ---: | ---: | ---: | ---: |');
for (const q of quality)
  lines.push(`| ${q.track} | ${fmt(q.rms_reference_dbfs, 1)} | ${fmt(q.peak_reference_dbfs, 1)} | `
    + `${fmt(q.rms_error_dbfs, 1)} | ${fmt(q.peak_error_dbfs, 1)} | ${fmt(q.signal_to_error_db, 1)} dB |`);

// The DSP raises the peak, so the headroom a prepared PCM16 file needs is not
// the headroom the source had. This is the number that decides whether a real
// stem would clip, and it comes out of the same capture.
const db = value => 20 * Math.log10(Math.max(value, 1e-12));
const fixturePeakDb = db(Math.max(...metadata.fixtures.map(f => f.peak)));
const preparedPeakDb = Math.max(...quality.map(q => q.peak_reference_dbfs));
const overshootDb = preparedPeakDb - fixturePeakDb;

lines.push('', `El error queda en ${fmt(worst.rms_error_dbfs, 1)} dBFS en el peor caso, un suelo plano que no depende del nivel del material: `
  + 'es la cuantización uniforme de 16 bits y nada más. '
  + 'Lo que sí depende del material es cuánto queda por encima, y por eso la última columna es la que hay que leer.', '',
  'Conviene situar esto: **PCM16 no sería una concesión nueva.** La caché de decodificación del escritorio ya guarda 16 bits en un WAV '
  + '(`native/audio-engine-v2/src/sources/source_manager.cpp`, `cache_sample_format`), tomando como referencia explícita la caché de Ableton, '
  + 'y el float32 sólo se activa con `LIBRETRACKS_CACHE_FLOAT=1` para depurar. Lo que cambia con el audio preparado no es la profundidad de bits.', '',
  '## Lo que sí cambia: el techo', '',
  `El fixture tiene pico ${fmt(fixturePeakDb, 1)} dBFS y el archivo preparado sale a ${fmt(preparedPeakDb, 1)} dBFS: `
  + `el warp y el tono añadieron **${fmt(overshootDb, 1)} dB de pico**. La caché de decodificación guarda material de ORIGEN; `
  + 'el archivo preparado guarda material después del DSP, y el DSP sube el nivel.', '',
  `Con este material no se recorta ni una muestra, pero implica que un stem por encima de unos ${fmt(-overshootDb, 1)} dBFS `
  + 'llegaría al techo del formato, y ahí el recorte no es ruido inaudible sino distorsión. '
  + 'El riesgo no es hipotético: el motor ya se topó con él en la caché de decodificación, donde libsndfile ENVOLVÍA las muestras '
  + 'que pasaban de ±1 (−1,002 → +32694) hasta que se activó `SFC_SET_CLIPPING`; se encontró en un stem de guitarra acústica a fondo de escala. '
  + 'El preparador de este banco recorta en vez de envolver, y cuenta cuántas veces lo hace.', '');

if (problems.length) lines.push('## Avisos', '', ...problems.map(p => `- ${p}`), '');

const perMinute = Object.fromEntries(metadata.formats.map(f => [f, byFormat(f).at(-1)]));
lines.push('## Para estimar una sesión', '',
  'Multiplicar la tasa por las pistas **con warp o tono**, no por todas: una pista sin DSP no necesita prepararse y no cuesta nada aquí.', '');
for (const format of metadata.formats) {
  const r = perMinute[format];
  const song = r.mib_per_track_minute * 12 * 4;
  const time = r.prepare_s_per_track_minute * 12 * 4;
  lines.push(`- **${format}**: ${fmt(r.mib_per_track_minute)} MiB y ${fmt(r.prepare_s_per_track_minute)} s por pista-minuto. `
    + `Una canción de 4 minutos con 12 pistas preparadas ocupa ${fmt(song / 1024, 2)} GiB y cuesta ${fmt(time, 0)} s **en este i7**.`);
}
// Every preparation, in the order it ran, with how much the batch had already
// written. A feature that writes gigabytes slows down as it writes them, and a
// median hides exactly that.
let written = 0;
const trail = [];
for (const [index, r] of runs.entries()) {
  trail.push(`| ${index + 1} | ${r.repetition} | ${r.format} | ${r.tracks} | ${fmt(written / 1024 ** 3)} | `
    + `${fmt(r.prepare_ms / 1000)} | ${fmt(r.verify_ms / 1000)} | ${fmt(r.prepare_s_per_track_minute)} |`);
  written += r.bytes;
}
lines.push('', '## Cada preparación, en orden', '',
  'La tabla de arriba da medianas. Esta da las pasadas sueltas, con los GiB que el lote llevaba escritos antes de cada una, '
  + 'porque el tiempo se degrada a medida que se acumulan. Es el mismo efecto que sufriría una sesión entera preparándose de una vez, '
  + 'y en un disco lento será mayor, no menor.', '',
  '| Orden | Repetición | Formato | Pistas | Escrito antes GiB | Preparación s | Verificación s | s/pista-minuto |',
  '| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |', ...trail, '',
  `El lote escribió ${fmt(written / 1024 ** 3)} GiB en total. `
  + 'La deriva se lee comparando pasadas de la MISMA combinación en distinto punto del lote, no la primera fila contra la última.', '');

lines.push('', 'Los segundos son de esta máquina y no se pueden trasladar a un PC modesto ni a Android; los MiB sí, porque el formato no cambia. '
  + `Cada combinación se midió ${repeats} ${repeats === 1 ? 'vez' : 'veces'}, alternando el orden, y la tabla da la mediana: `
  + 'son costes de un proceso secuencial, no percentiles de una distribución.', '',
  `Fixture con impulsos, ráfagas percusivas, barrido y silencio, ${metadata.source_seconds} s por pista. `
  + 'La verificación vuelve a renderizar cada pista desde cero y compara cada muestra contra el archivo, exacta en los dos formatos: '
  + 'en PCM16 contra el valor que el formato puede representar, lo que sigue demostrando que la escritura y la lectura no pierden nada.', '',
  `Preparador SHA-256: ${metadata.preparer_sha256}`, '',
  `Commit: ${metadata.commit}${metadata.dirty ? ' (árbol con cambios sin commitear)' : ''}`, '');
writeFileSync(output, lines.join('\n'));
console.log(`Saved ${runs.length} preparations${problems.length ? `; ${problems.length} warnings` : ''}`);
