// Banco de pruebas de LibreTracks en un dispositivo Android real.
//
// Mide lo que el plan docs/plans/android-low-end/ afirma que va a mejorar:
// memoria del proceso, memoria disponible del sistema, espacio consumido en
// disco y muertes de procesos por presion de memoria (el fallo que motivo el
// plan reinicio el system_server del Oppo CPH1931).
//
// Se ejecuta A MANO con el dispositivo conectado por USB. No es un test de CI:
// no hay dispositivo en el runner, y este repo ya tiene precedente de tests
// dependientes de temporizacion que tumbaron releases.
//
//   node ./scripts/android-bench.mjs --scenario import-full
//   node ./scripts/android-bench.mjs --list
//
// Ver docs/testing.md ("Banco de pruebas en Android").

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

const PACKAGE = "com.libretracks.desktop";

// Etiquetas del motor que interesan durante una medicion. [LT_STARVATION] marca
// hambruna del BlockCache (cortes de audio); las otras tres las anaden los pasos
// 01-03 del plan y aqui solo se recogen si estan presentes.
const ENGINE_LOG_TAGS = [
  "LT_STARVATION",
  "LT_DEVICE",
  "LT_THREADS",
  "LT_MEMPRESSURE",
];

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

// `manual` es lo que la persona debe hacer en el telefono mientras el script
// muestrea. No automatizamos el selector SAF: es un dialogo del sistema y
// pelearse con el haria la herramienta fragil sin medir nada mejor.
const SCENARIOS = {
  "import-full": {
    description: "Importar un .ltset Completo (el caso que reinicio el telefono)",
    metric: "Espacio consumido, duracion, pico de RSS, muertes por memoria",
    manual: [
      "En el telefono: menu Archivo -> Importar sesion (.ltset)",
      "Elige el .ltset a importar (p. ej. WhatAGod-Reckless.ltset)",
      "Elige donde guardarlo cuando lo pida",
      "Espera a que termine (o a que la app muera)",
    ],
    endHint: "cuando la sesion este abierta y preparada, o la app muera",
  },
  "import-optimized": {
    description: "Importar el mismo set exportado en modo Optimizado (paso 06)",
    metric: "Tiempo hasta listo, espacio consumido (deberia no escribir cache PCM)",
    manual: [
      "En el telefono: menu Archivo -> Importar sesion (.ltset)",
      "Elige el .ltset exportado como Optimizado",
      "Elige donde guardarlo cuando lo pida",
      "Espera a que la sesion este lista para reproducir",
    ],
    endHint: "cuando la sesion este lista para reproducir",
  },
  "open-prepared": {
    description: "Abrir una sesion ya importada",
    metric: "Tiempo hasta listo, pico de RSS",
    manual: [
      "En el telefono: abre una sesion ya importada desde la pantalla inicial",
      "Espera a que desaparezca 'Preparando audio'",
    ],
    endHint: "cuando la sesion este lista para reproducir",
  },
  "playback-8": {
    description: "Reproducir 8 pistas durante 60 s",
    metric: "Cortes de audio ([LT_STARVATION]), RSS estable",
    manual: [
      "Con una sesion de 8+ pistas abierta, pulsa Play",
      "Deja sonar 60 segundos y escucha si hay cortes",
    ],
    endHint: "tras 60 s de reproduccion",
  },
  pressure: {
    description: "Provocar presion de memoria durante una carga",
    metric: "Que la app sobreviva (sin am_proc_died de LibreTracks)",
    manual: [
      "Empieza a importar o abrir una sesion grande en LibreTracks",
      "Sin esperar, abre Chrome con varias pestanas y la camara",
      "Vuelve a LibreTracks y comprueba si sigue viva",
    ],
    endHint: "cuando la carga termine o la app muera",
  },
};

// ---------------------------------------------------------------------------
// adb
// ---------------------------------------------------------------------------

function resolveAdb(explicit) {
  if (explicit) return explicit;
  if (process.env.ADB) return process.env.ADB;

  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, "Android", "Sdk", "platform-tools", "adb.exe"));
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    candidates.push(path.join(home, "Android", "Sdk", "platform-tools", "adb"));
    candidates.push(path.join(home, "Library", "Android", "sdk", "platform-tools", "adb"));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Ultimo recurso: confiar en el PATH.
  return "adb";
}

let adbPath = "adb";
let adbSerial = null;

function adb(args, { allowFailure = false } = {}) {
  const full = adbSerial ? ["-s", adbSerial, ...args] : args;
  const result = spawnSync(adbPath, full, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    if (allowFailure) return "";
    fail(
      `No se pudo ejecutar adb (${adbPath}): ${result.error.message}\n` +
        "Instala platform-tools o indica la ruta con --adb <ruta> o la variable ADB.",
    );
  }
  if (result.status !== 0 && !allowFailure) {
    const stderr = (result.stderr || "").trim();
    fail(`adb ${full.join(" ")} fallo (codigo ${result.status})${stderr ? `: ${stderr}` : ""}`);
  }
  return (result.stdout || "").trim();
}

function shell(command, options) {
  return adb(["shell", command], options);
}

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

// Comprueba que hay exactamente un dispositivo utilizable y da un mensaje util
// cuando no lo hay. Sin esto el resto del script falla de formas crípticas.
function requireDevice(preferredSerial) {
  // Distinguir "adb no existe" de "no hay dispositivo": son dos problemas
  // distintos y el mensaje generico mandaba a revisar el cable cuando lo que
  // faltaba era el ejecutable.
  const probe = spawnSync(adbPath, ["version"], { encoding: "utf8" });
  if (probe.error) {
    fail(
      `No se encuentra adb en '${adbPath}'.\n` +
        "  - Instala Android platform-tools, o\n" +
        "  - Indica la ruta con --adb <ruta>, o la variable de entorno ADB",
    );
  }

  const raw = adb(["devices"], { allowFailure: true });
  const lines = raw
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = lines.map((line) => {
    const [serial, state] = line.split(/\s+/);
    return { serial, state };
  });

  if (parsed.length === 0) {
    fail(
      "No hay ningun dispositivo conectado.\n" +
        "  - Conecta el telefono por USB\n" +
        "  - Activa la depuracion USB en Opciones de desarrollador\n" +
        "  - Comprueba con: adb devices",
    );
  }

  const unauthorized = parsed.filter((device) => device.state === "unauthorized");
  const ready = parsed.filter((device) => device.state === "device");

  if (ready.length === 0 && unauthorized.length > 0) {
    fail(
      `El dispositivo ${unauthorized[0].serial} esta conectado pero NO autorizado.\n` +
        "Desbloquea el telefono y acepta el dialogo 'Permitir depuracion USB'.",
    );
  }
  if (ready.length === 0) {
    const states = parsed.map((d) => `${d.serial} (${d.state})`).join(", ");
    fail(`Ningun dispositivo listo. Estado actual: ${states}`);
  }

  if (preferredSerial) {
    const match = ready.find((device) => device.serial === preferredSerial);
    if (!match) {
      const available = ready.map((d) => d.serial).join(", ");
      fail(`El dispositivo '${preferredSerial}' no esta disponible. Conectados: ${available}`);
    }
    return preferredSerial;
  }

  if (ready.length > 1) {
    const available = ready.map((d) => d.serial).join(", ");
    fail(`Hay varios dispositivos conectados (${available}). Elige uno con --device <serial>.`);
  }

  return ready[0].serial;
}

function requireApp() {
  const packages = shell(`pm list packages ${PACKAGE}`, { allowFailure: true });
  if (!packages.includes(PACKAGE)) {
    fail(
      `La app ${PACKAGE} no esta instalada en el dispositivo.\n` +
        "Instalala antes de medir (npx tauri android build / adb install).",
    );
  }
}

// ---------------------------------------------------------------------------
// Lectura de metricas
//
// Todo lo de aqui funciona SIN root. Nota importante: /proc/<pid>/io NO es
// legible sin root en Android 10 (Permission denied, verificado en el
// CPH1931), asi que los bytes escritos por el proceso se aproximan por el
// espacio consumido en /data medido con df. Eso mide el efecto neto en disco,
// que es lo que le importa al usuario, aunque no distinga escrituras
// sobreescritas ni el trafico de otras apps.
// ---------------------------------------------------------------------------

function readDeviceProfile() {
  const meminfo = shell("cat /proc/meminfo", { allowFailure: true });
  const cores = Number(shell("cat /proc/cpuinfo | grep -c processor", { allowFailure: true })) || null;

  return {
    model: shell("getprop ro.product.model", { allowFailure: true }),
    device: shell("getprop ro.product.device", { allowFailure: true }),
    android_release: shell("getprop ro.build.version.release", { allowFailure: true }),
    android_sdk: Number(shell("getprop ro.build.version.sdk", { allowFailure: true })) || null,
    abi: shell("getprop ro.product.cpu.abi", { allowFailure: true }),
    cores,
    heap_growth_limit: shell("getprop dalvik.vm.heapgrowthlimit", { allowFailure: true }),
    heap_size: shell("getprop dalvik.vm.heapsize", { allowFailure: true }),
    mem_total_kb: parseMeminfoField(meminfo, "MemTotal"),
    mem_available_kb: parseMeminfoField(meminfo, "MemAvailable"),
    data_free_kb: readDataFreeKb(),
    app_version: readAppVersion(),
  };
}

function parseMeminfoField(meminfo, field) {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(meminfo || "");
  return match ? Number(match[1]) : null;
}

function readAppVersion() {
  const dump = shell(`dumpsys package ${PACKAGE} | grep versionName`, { allowFailure: true });
  const match = /versionName=(\S+)/.exec(dump || "");
  return match ? match[1] : null;
}

// Espacio USADO en /data, en kB. La diferencia entre dos lecturas es cuanto
// disco ha consumido la operacion medida.
function readDataUsedKb() {
  const line = shell("df /data | tail -1", { allowFailure: true });
  const parts = (line || "").trim().split(/\s+/);
  const used = Number(parts[2]);
  return Number.isFinite(used) ? used : null;
}

function readDataFreeKb() {
  const line = shell("df /data | tail -1", { allowFailure: true });
  const parts = (line || "").trim().split(/\s+/);
  const free = Number(parts[3]);
  return Number.isFinite(free) ? free : null;
}

function readPid() {
  const pid = shell(`pidof ${PACKAGE}`, { allowFailure: true }).trim().split(/\s+/)[0];
  return pid && /^\d+$/.test(pid) ? pid : null;
}

// RSS y pico historico del proceso. /proc/<pid>/status SI es legible sin root
// (verificado en el CPH1931) y VmHWM da el pico gratis, sin depender de la
// frecuencia de muestreo.
function readProcessMemory(pid) {
  if (!pid) return { rss_kb: null, hwm_kb: null };
  const status = shell(`grep -E 'VmRSS|VmHWM' /proc/${pid}/status`, { allowFailure: true });
  const rss = /VmRSS:\s+(\d+)\s+kB/.exec(status || "");
  const hwm = /VmHWM:\s+(\d+)\s+kB/.exec(status || "");
  return {
    rss_kb: rss ? Number(rss[1]) : null,
    hwm_kb: hwm ? Number(hwm[1]) : null,
  };
}

// Fluidez de la UI. dumpsys gfxinfo es legible sin root (verificado en el
// CPH1931) y es la unica forma objetiva que tenemos de medir "la app va lenta":
// la baseline de import-full la dejo inusable con starvation=0, porque la
// hambruna del audio y el jank de la UI son cosas distintas.
//
// `reset` limpia los contadores para que la ventana medida sea solo la
// operacion, no toda la vida del proceso.
function readJank({ reset = false } = {}) {
  const raw = shell(`dumpsys gfxinfo ${PACKAGE}${reset ? " reset" : ""}`, {
    allowFailure: true,
  });

  const number = (pattern) => {
    const match = pattern.exec(raw || "");
    return match ? Number(match[1]) : null;
  };

  const total = number(/Total frames rendered:\s+(\d+)/);
  const janky = number(/Janky frames:\s+(\d+)/);

  return {
    total_frames: total,
    janky_frames: janky,
    janky_percent:
      total && janky != null && total > 0 ? Number(((janky / total) * 100).toFixed(2)) : null,
    p50_ms: number(/50th percentile:\s+(\d+)ms/),
    p90_ms: number(/90th percentile:\s+(\d+)ms/),
    p95_ms: number(/95th percentile:\s+(\d+)ms/),
    p99_ms: number(/99th percentile:\s+(\d+)ms/),
    missed_vsync: number(/Number Missed Vsync:\s+(\d+)/),
    slow_ui_thread: number(/Number Slow UI thread:\s+(\d+)/),
    frame_deadline_missed: number(/Number Frame deadline missed:\s+(\d+)/),
  };
}

function readMemAvailableKb() {
  const line = shell("grep MemAvailable /proc/meminfo", { allowFailure: true });
  const match = /MemAvailable:\s+(\d+)\s+kB/.exec(line || "");
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Escenario
// ---------------------------------------------------------------------------

function clearLogcat() {
  adb(["logcat", "-b", "all", "-c"], { allowFailure: true });
}

// Muertes de procesos por presion de memoria durante la ventana medida. La
// firma del incidente del 20-08 fue una cascada de estas.
function collectKills() {
  const raw = adb(["logcat", "-b", "events", "-d"], { allowFailure: true });
  const kills = [];
  for (const line of raw.split("\n")) {
    if (!/am_kill|am_proc_died/.test(line)) continue;
    kills.push(line.trim());
  }
  return kills;
}

function collectEngineLogs() {
  const raw = adb(["logcat", "-b", "all", "-d"], { allowFailure: true });
  const matches = [];
  for (const line of raw.split("\n")) {
    if (ENGINE_LOG_TAGS.some((tag) => line.includes(tag))) {
      matches.push(line.trim());
    }
  }
  return matches;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMb(kb) {
  if (kb == null) return "n/d";
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatGb(kb) {
  if (kb == null) return "n/d";
  return `${(kb / 1024 / 1024).toFixed(2)} GB`;
}

// Una sola invocacion de adb por muestra. Con una llamada por metrica el ciclo
// tardaba ~1,5 s (5 x ~100 ms de arranque de adb + sleep), lo que falseaba el
// intervalo pedido y perdia resolucion justo en los picos que buscamos.
const SAMPLE_COMMAND = [
  `P=$(pidof ${PACKAGE})`,
  'echo "PID:${P:-none}"',
  'if [ -n "$P" ]; then grep -E "VmRSS|VmHWM" /proc/$P/status 2>/dev/null; fi',
  "grep MemAvailable /proc/meminfo",
  'echo "DF:$(df /data | tail -1)"',
].join("; ");

function readSample() {
  const raw = shell(SAMPLE_COMMAND, { allowFailure: true });

  const pidMatch = /PID:(\d+)/.exec(raw);
  const rssMatch = /VmRSS:\s+(\d+)\s+kB/.exec(raw);
  const hwmMatch = /VmHWM:\s+(\d+)\s+kB/.exec(raw);
  const availMatch = /MemAvailable:\s+(\d+)\s+kB/.exec(raw);
  const dfMatch = /DF:\S+\s+\d+\s+(\d+)\s+(\d+)/.exec(raw);

  return {
    pid: pidMatch ? Number(pidMatch[1]) : null,
    rss_kb: rssMatch ? Number(rssMatch[1]) : null,
    hwm_kb: hwmMatch ? Number(hwmMatch[1]) : null,
    mem_available_kb: availMatch ? Number(availMatch[1]) : null,
    data_used_kb: dfMatch ? Number(dfMatch[1]) : null,
  };
}

// Bucle de muestreo. Corre hasta que `shouldStop()` devuelve true; el usuario
// lo detiene pulsando Intro, asi que la duracion la marca la operacion real.
async function sampleUntil(shouldStop, intervalMs) {
  const samples = [];
  const startedAt = Date.now();
  let appSeen = false;
  let appDisappeared = false;

  while (!shouldStop()) {
    const tickStartedAt = Date.now();
    const sample = readSample();

    if (sample.pid) appSeen = true;
    else if (appSeen) appDisappeared = true;

    samples.push({ t_ms: tickStartedAt - startedAt, ...sample });

    process.stdout.write(
      `\r  t=${String(Math.round((Date.now() - startedAt) / 1000)).padStart(4)}s  ` +
        `RSS=${formatMb(sample.rss_kb).padStart(9)}  ` +
        `libre=${formatMb(sample.mem_available_kb).padStart(9)}  ` +
        `muestras=${samples.length}   `,
    );

    // Descontar lo que costo la propia lectura para no derivar del intervalo.
    const elapsed = Date.now() - tickStartedAt;
    if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
  }
  process.stdout.write("\n");

  return { samples, appDisappeared };
}

async function runScenario(scenarioId, options) {
  const scenario = SCENARIOS[scenarioId];

  console.log(`\n=== Escenario: ${scenarioId} ===`);
  console.log(scenario.description);
  console.log(`Metrica principal: ${scenario.metric}\n`);

  const profile = readDeviceProfile();
  console.log(`Dispositivo: ${profile.model} (Android ${profile.android_release}, ${profile.abi})`);
  console.log(`RAM: ${formatGb(profile.mem_total_kb)} total, ${formatGb(profile.mem_available_kb)} disponible`);
  console.log(`Disco /data: ${formatGb(profile.data_free_kb)} libres`);
  console.log(`App: ${PACKAGE} ${profile.app_version || "(version desconocida)"}\n`);

  if (scenarioId === "import-full" && !options.yes) {
    console.log("AVISO: contra el build actual, este escenario puede reiniciar el telefono.");
    console.log("Cierra lo que tengas abierto antes de continuar.\n");
    const answer = await ask("Continuar? [s/N] ");
    if (!/^s(i)?$/i.test(answer)) {
      console.log("Cancelado.");
      process.exit(0);
    }
  }

  console.log("Pasos a realizar EN EL TELEFONO:");
  scenario.manual.forEach((step, index) => {
    console.log(`  ${index + 1}. ${step}`);
  });
  console.log("");

  clearLogcat();
  // Contadores de frames a cero: la ventana medida es la operacion, no toda la
  // vida del proceso.
  readJank({ reset: true });
  const dataUsedBefore = readDataUsedKb();
  const memAvailableBefore = readMemAvailableKb();

  await ask("Pulsa Intro JUSTO ANTES de empezar la operacion en el telefono... ");

  const startedAt = Date.now();
  let stopped = false;
  let stopReason = "manual";
  // Segundo readline en paralelo al muestreo: la persona marca el final.
  const stopper = ask(`\nMuestreando. Pulsa Intro ${scenario.endHint}...\n`).then(() => {
    stopped = true;
  });

  // Corte automatico: si la app muere (o el sistema se reinicia) nadie puede
  // pulsar Intro, y sin esto el script se quedaria colgado justo en el caso
  // MAS interesante de medir. Se para tambien al llegar al limite de tiempo.
  const deadline = startedAt + options.maxSeconds * 1000;
  const shouldStop = () => {
    if (stopped) return true;
    if (Date.now() >= deadline) {
      stopped = true;
      stopReason = "timeout";
      return true;
    }
    return false;
  };

  const { samples, appDisappeared } = await sampleUntil(shouldStop, options.interval);

  if (stopReason === "timeout") {
    console.log(`\nLimite de ${options.maxSeconds}s alcanzado; se detiene el muestreo.`);
    console.log("Pulsa Intro para continuar.");
  }
  await stopper;

  const durationMs = Date.now() - startedAt;
  const dataUsedAfter = readDataUsedKb();
  const jank = readJank();
  const kills = collectKills();
  const engineLogs = collectEngineLogs();

  const appKills = kills.filter((line) => line.includes(PACKAGE));
  const rssValues = samples.map((s) => s.rss_kb).filter((v) => v != null);
  const hwmValues = samples.map((s) => s.hwm_kb).filter((v) => v != null);
  const availableValues = samples.map((s) => s.mem_available_kb).filter((v) => v != null);

  const starvation = engineLogs.filter((line) => line.includes("LT_STARVATION"));

  // Un reinicio del sistema no se puede observar desde aqui (el script pierde
  // el dispositivo); lo marca la persona con --outcome.
  let outcome = options.outcome;
  if (!outcome) {
    if (appDisappeared || appKills.length > 0) outcome = "app_died";
    else outcome = "completed";
  }

  const result = {
    scenario: scenarioId,
    recorded_at: new Date().toISOString(),
    outcome,
    stop_reason: stopReason,
    duration_ms: durationMs,
    device: profile,
    disk: {
      used_before_kb: dataUsedBefore,
      used_after_kb: dataUsedAfter,
      consumed_kb:
        dataUsedBefore != null && dataUsedAfter != null ? dataUsedAfter - dataUsedBefore : null,
    },
    memory: {
      available_before_kb: memAvailableBefore,
      available_min_kb: availableValues.length ? Math.min(...availableValues) : null,
      rss_peak_kb: rssValues.length ? Math.max(...rssValues) : null,
      // VmHWM es el pico real del kernel, independiente del muestreo.
      hwm_peak_kb: hwmValues.length ? Math.max(...hwmValues) : null,
    },
    ui: jank,
    kills: {
      total: kills.length,
      libretracks: appKills.length,
      lines: kills.slice(0, 60),
    },
    engine_logs: {
      starvation_count: starvation.length,
      lines: engineLogs.slice(0, 60),
    },
    samples,
    notes: options.notes || null,
  };

  printSummary(result);
  return result;
}

function printSummary(result) {
  const { memory, disk, kills, engine_logs: engineLogs, ui } = result;

  console.log("\n--- Resumen ---");
  console.log(`Escenario:        ${result.scenario}`);
  console.log(`Resultado:        ${result.outcome}`);
  console.log(`Duracion:         ${(result.duration_ms / 1000).toFixed(1)} s`);
  console.log(`Disco consumido:  ${formatMb(disk.consumed_kb)}`);
  console.log(`Pico RSS:         ${formatMb(memory.rss_peak_kb)} (VmHWM ${formatMb(memory.hwm_peak_kb)})`);
  console.log(`Memoria libre min:${formatMb(memory.available_min_kb)}`);
  console.log(`Muertes totales:  ${kills.total}  (LibreTracks: ${kills.libretracks})`);
  console.log(`Hambruna audio:   ${engineLogs.starvation_count} eventos [LT_STARVATION]`);
  if (ui && ui.total_frames) {
    console.log(
      `Fluidez UI:       ${ui.janky_percent}% frames con jank ` +
        `(${ui.janky_frames}/${ui.total_frames}), p99 ${ui.p99_ms} ms`,
    );
  }

  console.log("\nLectura:");
  if (kills.libretracks > 0) {
    console.log("  ! LibreTracks fue MATADA por el sistema durante la medicion.");
  }
  if (kills.total > 20) {
    console.log(`  ! ${kills.total} muertes de procesos: cascada de presion de memoria.`);
    console.log("    Es la firma del incidente que motivo el plan.");
  }
  if (engineLogs.starvation_count > 0) {
    console.log("  ! Hubo hambruna del BlockCache: cortes de audio probables.");
  }
  // Umbrales de jank: por encima del 20% de frames la lentitud es evidente a
  // simple vista, y un p99 por encima de 100ms son tirones de mas de 6 frames.
  const jankyUi = ui && ui.janky_percent != null && ui.janky_percent > 20;
  const slowP99 = ui && ui.p99_ms != null && ui.p99_ms > 100;
  if (jankyUi || slowP99) {
    console.log(
      `  ! UI lenta: ${ui.janky_percent}% de frames con jank, p99 ${ui.p99_ms} ms.` +
        " La app se percibe a tirones.",
    );
  }
  if (
    kills.libretracks === 0 &&
    kills.total <= 20 &&
    engineLogs.starvation_count === 0 &&
    !jankyUi &&
    !slowP99
  ) {
    console.log("  OK: sin muertes de la app, sin cascada, sin hambruna, UI fluida.");
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const values = {
    scenario: null,
    out: null,
    interval: 1000,
    maxSeconds: 1800,
    device: null,
    adb: null,
    outcome: null,
    notes: null,
    list: false,
    yes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--scenario" && next) {
      values.scenario = next;
      index += 1;
    } else if (arg === "--out" && next) {
      values.out = path.resolve(next);
      index += 1;
    } else if (arg === "--interval" && next) {
      values.interval = Number(next);
      index += 1;
    } else if (arg === "--max-seconds" && next) {
      values.maxSeconds = Number(next);
      index += 1;
    } else if (arg === "--device" && next) {
      values.device = next;
      index += 1;
    } else if (arg === "--adb" && next) {
      values.adb = next;
      index += 1;
    } else if (arg === "--outcome" && next) {
      values.outcome = next;
      index += 1;
    } else if (arg === "--notes" && next) {
      values.notes = next;
      index += 1;
    } else if (arg === "--list") {
      values.list = true;
    } else if (arg === "--yes" || arg === "-y") {
      values.yes = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return values;
}

function printUsage() {
  console.log(`
Banco de pruebas de LibreTracks en Android.

  node ./scripts/android-bench.mjs --scenario <id> [opciones]

Opciones:
  --scenario <id>   Escenario a medir (--list para verlos)
  --out <fichero>   Guardar el JSON del resultado
  --interval <ms>   Intervalo de muestreo (por defecto 1000)
  --max-seconds <s> Corte automatico del muestreo (por defecto 1800)
  --device <serial> Dispositivo, si hay varios conectados
  --adb <ruta>      Ruta a adb (o variable de entorno ADB)
  --outcome <texto> Forzar el resultado (p. ej. system_restart)
  --notes <texto>   Nota libre que se guarda en el JSON
  --list            Listar escenarios
  --yes             No pedir confirmacion en escenarios peligrosos

Ejemplos:
  node ./scripts/android-bench.mjs --list
  node ./scripts/android-bench.mjs --scenario import-full --out baseline.json
`);
}

function printScenarios() {
  console.log("\nEscenarios disponibles:\n");
  for (const [id, scenario] of Object.entries(SCENARIOS)) {
    console.log(`  ${id.padEnd(18)} ${scenario.description}`);
    console.log(`  ${" ".repeat(18)} metrica: ${scenario.metric}\n`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    printScenarios();
    return;
  }

  if (!options.scenario) {
    printUsage();
    printScenarios();
    fail("Falta --scenario. Elige uno de la lista.");
  }

  if (false && !SCENARIOS[options.scenario]) {
    const available = Object.keys(SCENARIOS).join(", ");
    fail(`Escenario desconocido '${options.scenario}'. Disponibles: ${available}`);
  }

  if (!Number.isFinite(options.interval) || options.interval < 200) {
    fail("--interval debe ser un numero de milisegundos >= 200.");
  }

  if (!Number.isFinite(options.maxSeconds) || options.maxSeconds < 10) {
    fail("--max-seconds debe ser un numero de segundos >= 10.");
  }

  adbPath = resolveAdb(options.adb);
  adbSerial = requireDevice(options.device);
  requireApp();

  const result = await runScenario(options.scenario, options);

  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Resultado guardado en ${options.out}\n`);
  } else {
    console.log("(Sin --out: el resultado no se ha guardado en disco.)\n");
  }
}

main().catch((error) => {
  fail(error?.stack || String(error));
});
