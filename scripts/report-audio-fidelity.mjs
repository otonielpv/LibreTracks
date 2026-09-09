import { readFileSync, writeFileSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/report-audio-fidelity.mjs results.json report.md');
const { metadata, preparations, rows } = JSON.parse(readFileSync(input, 'utf8'));
if (metadata.mode !== 'fidelity' || !Number.isInteger(metadata.repeats) || metadata.repeats < 1)
  throw new Error('Expected a fidelity capture');
if (preparations.length !== 2 || new Set(preparations.map(p => p.block)).size !== 2)
  throw new Error('Incomplete preparations');
const format = metadata.format ?? 'float32';
for (const p of preparations) {
  if (![128, 512].includes(p.block) || p.tracks !== 1 || p.seconds !== metadata.timeline_seconds
    || p.ratio !== metadata.warp_ratio || p.semitones !== metadata.semitones
    || (p.format ?? 'float32') !== format
    || p.samples_verified !== metadata.timeline_seconds * metadata.sample_rate * 2 || !(p.energy > 0))
    throw new Error('Preparation did not verify the whole continuous render');
}

const TRANSPORT_SCENARIOS = ['start', 'forward', 'backward', 'resume'];
const CONTROL_SCENARIOS = ['none', 'gain', 'pan', 'mute'];
const SCENARIOS = [...TRANSPORT_SCENARIOS, ...CONTROL_SCENARIOS];
const BLOCKS = [128, 512];
const groups = new Map();
for (const r of rows) {
  if (!SCENARIOS.includes(r.scenario) || !BLOCKS.includes(r.block)
    || !Number.isInteger(r.repetition) || r.repetition < 0 || r.repetition >= metadata.repeats)
    throw new Error('Unexpected case in the capture');
  // A comparison between two different moments proves nothing, and a starved
  // read looks exactly like a fidelity difference. Neither may be reported.
  if (!r.same_timeline) throw new Error(`Routes walked different timelines: ${r.scenario}/${r.block}`);
  if (r.live.missing_source_frames || r.prepared.missing_source_frames)
    throw new Error(`Capture read uncached audio: ${r.scenario}/${r.block}`);
  if (r.live.active_voices_end !== 1 || r.live.path_direct || !r.live.path_stretched
    || r.live.warp_ratio !== metadata.warp_ratio || r.live.semitones !== metadata.semitones)
    throw new Error(`Live route did not run warp and pitch: ${r.scenario}/${r.block}`);
  if (r.prepared.active_voices_end !== 0 || r.prepared.path_stretched || r.prepared.path_varispeed)
    throw new Error(`Prepared route ran DSP it should not: ${r.scenario}/${r.block}`);
  const control = CONTROL_SCENARIOS.includes(r.scenario);
  if (control ? !r.control : !r.metrics) throw new Error(`Missing metrics: ${r.scenario}/${r.block}`);
  const key = `${r.block}/${r.scenario}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const hasControls = SCENARIOS.some(sc => CONTROL_SCENARIOS.includes(sc) && groups.has(`${BLOCKS[0]}/${sc}`));
const scenariosPresent = hasControls ? SCENARIOS : TRANSPORT_SCENARIOS;
if (groups.size !== BLOCKS.length * scenariosPresent.length) throw new Error('Incomplete fidelity matrix');

const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const LABEL = {
  start: 'Arranque', forward: 'Salto adelante', backward: 'Salto atrás', resume: 'Reanudación',
  none: 'Sin tocar nada (referencia)', gain: 'Ganancia a la mitad', pan: 'Panorama a la izquierda', mute: 'Enmudecer',
};

const lines = ['# Fidelidad del audio preparado en arranques y saltos', '',
  `${metadata.cpu}; Release; una pista, warp ${String(metadata.warp_ratio).replace('.', ',')} y tono ${metadata.semitones >= 0 ? '+' : ''}${metadata.semitones}; `
  + `archivo preparado en ${format}; ${metadata.repeats} repeticiones por caso.`, '',
  'Se compara el DSP vivo contra el archivo preparado en la misma línea de tiempo, con los manejadores reales de `CmdSeekAbsolute`, `CmdPlay` y `CmdPause`. '
  + 'No se exige igualdad muestra a muestra: el DSP vivo reconstruye las voces en el destino del salto y el archivo preparado conserva la historia de un render continuo, así que la fase de grano difiere por construcción. '
  + 'Lo que sí debe cumplirse es que llegue el mismo contenido, en el mismo instante y al mismo nivel.', ''];

const problems = [], unstable = [], explain = [];
lines.push('| Escenario | Buffer | Nivel ref. dBFS | Nivel 0-100 ms | Desfase ms | Correlación | Fiable | Error mediano dB | p95 dB | Máx dB >-40 dBFS | Recuperación ms | Silencio vivo | Silencio preparado | Clic vivo/preparado |',
  '| --- | ---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const block of BLOCKS) for (const scenario of TRANSPORT_SCENARIOS) {
  const group = groups.get(`${block}/${scenario}`);
  if (group.length !== metadata.repeats || new Set(group.map(r => r.repetition)).size !== metadata.repeats)
    throw new Error(`Missing or duplicate repetitions: ${scenario}/${block}`);
  // The capture is deterministic by construction — resident audio, synchronous
  // commands, no concurrency. If two repetitions differ, that is the finding.
  for (const route of ['live', 'prepared'])
    if (new Set(group.map(r => r[route].sha256)).size !== 1) unstable.push(`${LABEL[scenario]} ${block} (${route})`);
  const m = pick => median(group.map(r => pick(r.metrics)));
  const sum = pick => group.reduce((a, r) => a + pick(r.metrics), 0);
  const recoveries = group.map(r => r.metrics.recovery_ms);
  const recovery = recoveries.some(v => v === null) ? 'sin confirmar' : median(recoveries).toFixed(0);
  const reliable = group.every(r => r.metrics.alignment.reliable);
  if (!reliable) problems.push(`${LABEL[scenario]} ${block}: la búsqueda de alineación no encontró correspondencia`);
  if (sum(x => x.silent_in_live_windows) || sum(x => x.silent_in_prepared_windows))
    problems.push(`${LABEL[scenario]} ${block}: una ruta enmudece donde la otra suena`);
  if (recovery !== '0') for (const w of group[0].metrics.worst_windows.slice(0, 4))
    explain.push(`| ${LABEL[scenario]} | ${block} | ${w.ms.toFixed(0)} | ${w.reference_db.toFixed(1)} | ${w.live_db.toFixed(1)} | ${w.error_db.toFixed(2)} |`);
  const onset = m(x => x.reference_level.first_100ms_median_db);
  if (onset < -40) problems.push(`${LABEL[scenario]} ${block}: el evento cae sobre material a ${onset.toFixed(0)} dBFS; esa fila no compara nada audible`);
  lines.push(`| ${LABEL[scenario]} | ${block} | ${m(x => x.reference_level.median_db).toFixed(1)} | `
    + `${onset.toFixed(1)} | ${m(x => x.alignment.lag_ms).toFixed(2)} | `
    + `${m(x => x.alignment.correlation).toFixed(5)} | ${reliable ? 'sí' : '**no**'} | `
    + `${m(x => x.envelope_error.median_db).toFixed(3)} | ${m(x => x.envelope_error.p95_db).toFixed(2)} | `
    + `${m(x => x.envelope_error.max_db_above_signal).toFixed(2)} | `
    + `${recovery} | ${sum(x => x.silent_in_live_windows)} | ${sum(x => x.silent_in_prepared_windows)} | `
    + `${m(x => x.click.live_slew_ratio).toFixed(2)} / ${m(x => x.click.prepared_slew_ratio).toFixed(2)} |`);
}

// Mixer controls. The prepared file is written before gain, pan and mute, so
// each route's own level has to move by the same amount when one of them does.
// A route-to-route envelope comparison cannot answer this: it would look
// perfect for a prepared file with the gain baked in, right up until the user
// touches the fader.
if (hasControls) {
  lines.push('', '## Los controles del mezclador siguen vivos', '',
    'El archivo preparado se escribe ANTES de ganancia, panorama y enmudecido. La prueba no es que las dos rutas se parezcan '
    + '—eso ya se sabe—, sino que cada una cambie de nivel **lo mismo** cuando se mueve el control: si el preparado hubiera '
    + 'horneado la ganancia, las dos rutas seguirían pareciéndose hasta que alguien tocara el fader.', '',
    '| Control | Buffer | Canal | Efecto en vivo dB | Efecto en preparado dB | Diferencia dB |',
    '| --- | ---: | :---: | ---: | ---: | ---: |');
  for (const block of BLOCKS) for (const scenario of CONTROL_SCENARIOS) {
    const group = groups.get(`${block}/${scenario}`);
    if (!group || group.length !== metadata.repeats)
      throw new Error(`Missing or duplicate repetitions: ${scenario}/${block}`);
    for (const route of ['live', 'prepared'])
      if (new Set(group.map(r => r[route].sha256)).size !== 1) unstable.push(`${LABEL[scenario]} ${block} (${route})`);
    if (scenario === 'none') continue;  // It is the reference, not a result.
    for (const [channel, name] of ['I', 'D'].entries()) {
      const effectLive = median(group.map(r => r.control.effect_db.live[channel]));
      const effectPrepared = median(group.map(r => r.control.effect_db.prepared[channel]));
      const difference = effectLive - effectPrepared;
      // A control that acts on one route and not the other is the whole point.
      if (Math.abs(difference) > 0.5)
        problems.push(`${LABEL[scenario]} ${block}, canal ${name}: el control mueve la ruta viva ${difference.toFixed(2)} dB `
          + 'más que la preparada; una de las dos lo lleva horneado');
      lines.push(`| ${LABEL[scenario]} | ${block} | ${name} | ${effectLive.toFixed(2)} | `
        + `${effectPrepared.toFixed(2)} | ${difference.toFixed(2)} |`);
    }
  }
  const referenceRow = groups.get(`${BLOCKS[0]}/none`)[0].control;
  lines.push('', 'Los niveles son medias cuadráticas de medio segundo a cada lado del cambio, saltándose 50 ms.', '',
    'El suelo de enmudecer y de panorama **no es el mismo con los dos buffers**, y no es un fallo: el mezclador suaviza ganancia, '
    + 'panorama y mute con un polo simple cuyo coeficiente es `num_frames / (sample_rate · 10 ms)`, e interpola por muestra dentro del bloque. '
    + 'Con 512 ese coeficiente se satura a 1, así que el cambio es una rampa lineal limpia de 10,67 ms y a los 50 ms ya hay silencio digital. '
    + 'Con 128 vale 0,27 y el nivel decae geométricamente: sigue en −92 dBFS a los 50 ms y tarda unos 55 ms en apagarse del todo. '
    + 'Ninguna de las dos produce clics, y la diferencia es inaudible; se deja anotada, no corregida.', '',
    '**El efecto es un A/B, no una resta contra cero.** El nivel antes y después del evento no es el mismo material: con warp 1,2 las dos '
    + 'ventanas caen sobre trozos distintos del fixture, y ese cambio propio vale varios dB. '
    + `La pasada de referencia, que hace la captura idéntica sin tocar nada, midió ${referenceRow.live.delta_db.map(v => v.toFixed(2)).join(' / ')} dB `
    + 'en la ruta viva; cada efecto de arriba es la pasada con el control menos esa. Sin restarla, bajar la ganancia a la mitad se leía como +2,15 dB.', '',
    'Enmudecer lleva las dos rutas al suelo del medidor, así que su efecto no es una cifra con sentido físico; '
    + 'lo que importa ahí es que las dos caigan lo mismo.', '');
}

const anyRow = rows.find(r => r.metrics).metrics;
lines.push('', 'El nivel de referencia es el del archivo preparado: mediana de toda la ventana y de los primeros 100 ms. '
  + 'Sin él, un motor que tarda en asentarse y un evento que cae sobre silencio producen exactamente los mismos números de error.', '',
  `El error en dB sólo se calcula donde la referencia supera ${anyRow.envelope_error.reference_floor_db} dBFS. `
  + 'Sin esa puerta las estadísticas las domina el silencio: dos renders a −92 y −105 dBFS se diferencian en 13 dB y son ambos silencio. '
  + 'Las ventanas por debajo del suelo se cuentan aparte y las dos formas de equivocarse con el silencio (una ruta muda donde la otra suena) se cuentan explícitamente en sus propias columnas.', '',
  'El desfase se busca por correlación de envolvente, acotada para que un desplazamiento no pueda compararse sobre menos del 75 % de la ventana. '
  + '«Fiable» es la correlación en el mejor desplazamiento: si es «no», ningún desplazamiento alineó las dos capturas y el desfase de esa fila no significa nada.', '',
  'La relación de clic es el mayor salto entre muestras consecutivas en los 20 ms posteriores al fundido de salto, dividido por el percentil 99,9 de esa misma ruta ya asentada. '
  + 'Compara cada ruta consigo misma, así que no depende de lo abrupto que sea el material.', '');

if (explain.length) lines.push('## Ventanas que rompieron la convergencia', '',
  'Cada fila sin recuperación inmediata se desglosa aquí. Comprobar el nivel de referencia antes de leer el error: '
  + 'una diferencia de 3 dB a −55 dBFS está 30 dB por debajo del programa y no es lo mismo que una a −20 dBFS.', '',
  '| Escenario | Buffer | ms | Referencia dBFS | Vivo dBFS | Error dB |', '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...explain, '');
if (problems.length) lines.push('## Diferencias que hay que resolver antes de integrar', '', ...problems.map(p => `- ${p}`), '');
if (unstable.length) lines.push('## Capturas no deterministas', '',
  'Las mismas entradas produjeron audio distinto entre repeticiones. Hasta explicarlo, ninguna comparación de esas filas es concluyente.', '',
  ...unstable.map(p => `- ${p}`), '');

lines.push('## Alcance', '',
  `Fixture con impulsos, ráfagas percusivas, barrido y silencio (${metadata.source_seconds} s), pico ${metadata.fixture.peak.toFixed(3)}, `
  + `${metadata.fixture.impulses} impulsos. Una pista, una región, offsets cero, ganancia de clip unitaria y parámetros constantes. `
  + 'No cubre regiones múltiples, automatización, edición durante playback ni cambios de warp/tono en caliente.', '',
  'Los saltos se ejecutan de forma síncrona entre dos renders para que ambas rutas recorran exactamente la misma línea de tiempo; '
  + 'la latencia del salto concurrente la mide `bench_streaming_playback`, no esta captura. '
  + 'La fuente entera reside en memoria y cualquier fallo de lectura aborta la pasada: un bloque hambriento nunca puede aparecer aquí como diferencia de fidelidad.', '',
  'Banco sin dispositivo de audio, sin interfaz y sin carga térmica sostenida, sobre un PC potente. '
  + 'No es una emulación de Android ni demuestra ausencia de cortes en un driver real.', '',
  `Captura SHA-256: ${metadata.capture_sha256}`, '', `Preparador SHA-256: ${metadata.preparer_sha256}`, '',
  `Commit: ${metadata.commit}${metadata.dirty ? ' (árbol con cambios sin commitear)' : ''}`, '');
writeFileSync(output, lines.join('\n'));
console.log(`Saved ${groups.size} fidelity cases${problems.length ? `; ${problems.length} flagged` : ''}`);
