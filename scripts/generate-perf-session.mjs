/**
 * Genera la sesión de referencia GRANDE del plan `docs/plans/ui-performance`.
 *
 * Por qué hace falta: la sesión de capturas (3 canciones) es pequeña, y las
 * causas C4 (caché de tiles de onda) y C6 (dibujo O(proyecto)) escalan con el
 * tamaño del setlist. Sin un caso grande y **reproducible** no se puede
 * comparar un antes con un después, ni entre dos personas.
 *
 * ## La decisión de diseño que no hay que "limpiar"
 *
 * El setlist por defecto son 20 canciones x 25 pistas = 500 clips, pero sólo
 * unos pocos ficheros de audio reales (`--sources`, 4 por defecto), reutilizados
 * por todos los clips. Eso mantiene el disco en ~170 MB en vez de ~8 GB, y el
 * motor sólo decodifica 4 fuentes (SourceManager deduplica por ruta).
 *
 * PERO: la caché de tiles de waveform indexa por
 * `waveformKey:...:sourceStartSeconds:duration:...` (ver
 * `Renderer/WaveformTileCache.ts`, función `tileNamespace`). Si los 500 clips
 * compartieran los mismos valores, compartirían tiles, y el banco mediría una
 * presión de caché ridículamente baja — justo la métrica que venimos a medir.
 *
 * Por eso cada clip recibe un `sourceStartSeconds` escalonado unos pocos
 * milisegundos: audio compartido, namespaces de tile distintos. **Si alguien
 * "simplifica" ese escalonado, la sesión deja de medir C4.**
 *
 * Uso:
 *   node scripts/generate-perf-session.mjs --out samples/perf-setlist
 *   node scripts/generate-perf-session.mjs --out ... --songs 8 --tracks 12
 *
 * Después: abre la sesión UNA VEZ para que se generen los `.ltpeaks`, ciérrala
 * y vuelve a abrirla antes de medir (ver PROTOCOLO.md).
 */
import fs from "node:fs";
import path from "node:path";

const SONG_FILE_NAME = "song.ltsession";
const SONG_FORMAT_VERSION = 7;

/**
 * OJO: `MarkerKind` se serializa en **snake_case**, aunque el resto del
 * documento vaya en camelCase. Escribir `preChorus` aquí produce un JSON que
 * parece correcto y que el cargador de Rust rechaza. Lo cubre
 * `crates/libretracks-project/tests/perf_session_fixture.rs`.
 */
const MARKER_KINDS = [
  "intro",
  "verse",
  "pre_chorus",
  "chorus",
  "verse",
  "chorus",
  "bridge",
  "chorus",
  "outro",
];

const TRACK_COLORS = [
  "#e0625f",
  "#e0a35f",
  "#d7e05f",
  "#6fe05f",
  "#5fe0b8",
  "#5fb0e0",
  "#7a5fe0",
  "#d75fe0",
];

const GROUPS = ["Batería", "Bajo y guitarras", "Teclados", "Voces"];

function parseArgs(argv) {
  const values = {
    out: path.resolve("samples", "perf-setlist"),
    songs: 20,
    tracks: 25,
    songSeconds: 240,
    markersPerSong: 12,
    sources: 4,
    sampleRate: 44_100,
    bpm: 120,
    // Hueco entre canciones. NO lo bajes sin leer esto.
    //
    // Mover una region a la IZQUIERDA esta topada por el final de su vecina
    // (`minStartSeconds` en TimelineCanvasPane.beginRegionMove); a la derecha
    // el backend empuja en cascada. Con un hueco de 2 s — el valor original —
    // solo se podia arrastrar la ultima cancion del setlist, y la primera
    // medicion real se hizo con la 20 por ese motivo.
    //
    // 30 s da margen visible en los dos sentidos a cualquier zoom util, y solo
    // anade 10 min a un setlist de 20 canciones.
    gapSeconds: 30,
  };

  const numeric = new Set([
    "songs",
    "tracks",
    "songSeconds",
    "markersPerSong",
    "sources",
    "sampleRate",
    "bpm",
    "gapSeconds",
  ]);
  const aliases = {
    "--songs": "songs",
    "--tracks": "tracks",
    "--song-seconds": "songSeconds",
    "--markers": "markersPerSong",
    "--sources": "sources",
    "--sample-rate": "sampleRate",
    "--bpm": "bpm",
    "--gap": "gapSeconds",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--out" && next) {
      values.out = path.resolve(next);
      index += 1;
      continue;
    }
    const key = aliases[arg];
    if (key && next !== undefined) {
      values[key] = numeric.has(key) ? Number(next) : next;
      index += 1;
    }
  }

  return values;
}

/**
 * WAV PCM 16 bits estéreo. Cada fuente lleva un timbre distinto para que las
 * ondas no salgan todas iguales: una waveform plana no ejercita el mismo
 * camino de dibujo que una con dinámica.
 */
function writeStereoWav(filePath, { sampleRate, seconds, seed }) {
  const channels = 2;
  const bitsPerSample = 16;
  const totalFrames = Math.floor(sampleRate * seconds);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = totalFrames * blockAlign;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  const stream = fs.createWriteStream(filePath);
  stream.write(header);

  const baseHz = 110 * (1 + seed * 0.37);
  const chunkFrames = 1 << 15;
  const chunk = Buffer.alloc(chunkFrames * blockAlign);

  for (let frame = 0; frame < totalFrames; frame += chunkFrames) {
    const framesThisChunk = Math.min(chunkFrames, totalFrames - frame);
    for (let offset = 0; offset < framesThisChunk; offset += 1) {
      const absolute = frame + offset;
      const t = absolute / sampleRate;
      // Envolvente por compases: picos y valles claros, para que el dibujo de
      // min/max tenga algo que dibujar en todos los niveles de zoom.
      const bar = Math.floor(t / 2) % 4;
      const envelope = (0.25 + 0.75 * Math.abs(Math.sin(t * Math.PI))) * (bar === 3 ? 0.35 : 1);
      const left = Math.sin(2 * Math.PI * baseHz * t) * envelope * 0.7;
      const right =
        Math.sin(2 * Math.PI * baseHz * 1.5 * t + seed) * envelope * 0.55;
      chunk.writeInt16LE(Math.round(left * 32000), offset * blockAlign);
      chunk.writeInt16LE(Math.round(right * 32000), offset * blockAlign + 2);
    }
    stream.write(chunk.subarray(0, framesThisChunk * blockAlign));
  }

  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
}

function buildSong(options) {
  const {
    songs,
    tracks: trackCount,
    songSeconds,
    markersPerSong,
    sources,
    gapSeconds,
    bpm,
  } = options;

  const tracks = [];
  const groupIds = GROUPS.map((name, index) => {
    const id = `folder-${index}`;
    tracks.push({
      id,
      name,
      kind: "folder",
      parentTrackId: null,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      transposeEnabled: true,
      audioTo: "master",
      color: TRACK_COLORS[index % TRACK_COLORS.length],
      autoCreated: false,
      midiChannel: 1,
      midiEnabled: true,
      collapsed: false,
    });
    return id;
  });

  for (let index = 0; index < trackCount; index += 1) {
    tracks.push({
      id: `track-${index}`,
      name: `Pista ${String(index + 1).padStart(2, "0")}`,
      kind: "audio",
      // Reparte las pistas entre las carpetas: una jerarquía plana no ejercita
      // el conteo de hijos por carril ni el dibujo de la banda de carpeta.
      parentTrackId: groupIds[index % groupIds.length],
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      transposeEnabled: true,
      audioTo: "master",
      color: TRACK_COLORS[index % TRACK_COLORS.length],
      autoCreated: false,
      midiChannel: 1,
      midiEnabled: true,
      collapsed: false,
    });
  }

  const regions = [];
  const clips = [];
  const sectionMarkers = [];
  const sourceSeconds = songSeconds;

  let cursor = 0;
  for (let songIndex = 0; songIndex < songs; songIndex += 1) {
    const start = cursor;
    const end = start + songSeconds;
    regions.push({
      id: `region-${songIndex}`,
      name: `Canción ${String(songIndex + 1).padStart(2, "0")}`,
      startSeconds: start,
      endSeconds: end,
      transposeSemitones: 0,
      key: ["C", "D", "E", "F", "G", "A", "Bb"][songIndex % 7],
      warpEnabled: false,
      masterGain: 1,
    });

    for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
      // El escalonado que hace que cada clip tenga su propio namespace de tile.
      // NO lo quites: ver la cabecera de este fichero.
      const stagger = ((songIndex * trackCount + trackIndex) % 500) * 0.001;
      const duration = songSeconds - stagger - 0.05;
      clips.push({
        id: `clip-${songIndex}-${trackIndex}`,
        trackId: `track-${trackIndex}`,
        filePath: `audio/source-${trackIndex % sources}.wav`,
        timelineStartSeconds: start,
        sourceStartSeconds: stagger,
        durationSeconds: duration,
        gain: 1,
        fadeInSeconds: null,
        fadeOutSeconds: null,
      });
    }

    for (let markerIndex = 0; markerIndex < markersPerSong; markerIndex += 1) {
      const kind = MARKER_KINDS[markerIndex % MARKER_KINDS.length];
      sectionMarkers.push({
        id: `marker-${songIndex}-${markerIndex}`,
        name: `${kind} ${markerIndex + 1}`,
        startSeconds: start + (markerIndex * songSeconds) / markersPerSong,
        // Sin dígito: los atajos 1-9 son únicos en toda la canción y con 240
        // marcas no hay forma de repartirlos sin romper la validación.
        digit: null,
        kind,
      });
    }

    cursor = end + gapSeconds;
  }

  return {
    id: "perf-setlist",
    title: `Setlist de rendimiento (${songs} canciones)`,
    artist: "LibreTracks perf bench",
    key: null,
    bpm,
    timeSignature: "4/4",
    durationSeconds: Math.max(0, cursor - gapSeconds),
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions,
    tracks,
    clips,
    midiClips: [],
    sectionMarkers,
    sourceSeconds,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const audioDir = path.join(options.out, "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(path.join(options.out, "cache"), { recursive: true });

  const { sourceSeconds, ...song } = buildSong(options);

  const bytesPerSource = Math.floor(
    options.sampleRate * sourceSeconds * 2 * 2 + 44,
  );
  process.stdout.write(
    `Generando ${options.sources} fuentes de ${sourceSeconds}s ` +
      `(~${((bytesPerSource * options.sources) / (1024 * 1024)).toFixed(0)} MiB)...\n`,
  );

  for (let index = 0; index < options.sources; index += 1) {
    const filePath = path.join(audioDir, `source-${index}.wav`);
    if (
      fs.existsSync(filePath) &&
      fs.statSync(filePath).size === bytesPerSource
    ) {
      process.stdout.write(`  source-${index}.wav ya existe, se reutiliza\n`);
      continue;
    }
    await writeStereoWav(filePath, {
      sampleRate: options.sampleRate,
      seconds: sourceSeconds,
      seed: index,
    });
    process.stdout.write(`  source-${index}.wav\n`);
  }

  const document = { version: SONG_FORMAT_VERSION, ...song };
  fs.writeFileSync(
    path.join(options.out, SONG_FILE_NAME),
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );

  const gridMarkers = Math.round(
    (song.durationSeconds / 60) * options.bpm,
  );
  process.stdout.write(
    [
      "",
      `Sesión escrita en ${options.out}`,
      `  canciones (regiones): ${song.regions.length}`,
      `  pistas:               ${song.tracks.length} (${GROUPS.length} carpetas)`,
      `  clips:                ${song.clips.length}`,
      `  marcas de sección:    ${song.sectionMarkers.length}`,
      `  duración:             ${(song.durationSeconds / 60).toFixed(1)} min`,
      `  entradas de rejilla:  ~${gridMarkers} (lo que hoy se recorre por capa y por frame)`,
      "",
      "Ábrela una vez para que se generen los .ltpeaks, ciérrala y vuelve a",
      "abrirla antes de medir. Ver docs/plans/ui-performance/PROTOCOLO.md.",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
