// Records the scenes of the narrated "first song" tutorial ON A PHONE (the
// Android emulator), the mobile sibling of tests/e2e/specs/tutorial-video.e2e.ts.
// Each scene is screen-recorded on the device, letterboxed to 1920x1080 and
// written as <dir>/scenes/<id>.mp4; playback moments also record what the
// speaker plays (scripts/tutorial-video/loopback.py) so compose.mjs can mix
// the app's own sound under the narration.
//
//   LT_TUTORIAL_DIR=marketing/tutorial-video/primeros-pasos-movil \
//     node tests/android/tutorial-video/record.ts [--dry] [scene...]
//
// --dry runs the actions with a screenshot per scene instead of recording.
//
// LT_GUIDESHOTS_LANG=en records the English video: the app and its voice guide
// in English, labels from the app's own translation (uiText.ts). The system
// file picker stays in Spanish, like the Windows dialog in the desktop video.
//
// Before running (once per emulator): the stems in /sdcard/Music/<song>/ and
// indexed (adb shell content call --method scan_volume --uri content://media
// --arg external_primary). The run itself keeps the device landscape and the
// file picker in Spanish.
//
// The emulator's own audio is unusable (ARM translation: noise, no music), so
// the playback moments get the desktop tutorial's recordings of the same
// thing afterwards: scripts/tutorial-video/borrow-audio.mjs.
import { execSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADB,
  adb,
  APP,
  connect,
  disconnect,
  longPress,
  rectOf,
  run,
  send,
  setTouchRipple,
  sleep,
  tap,
  touch,
  uiNodes,
  uiTap,
  viewport,
  waitFor,
} from "../lib/device.ts";
import { L, UI_LANG } from "../../e2e/utils/uiText.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const tutorialDir = path.resolve(
  process.env.LT_TUTORIAL_DIR ?? `marketing/tutorial-video/${UI_LANG === "en" ? "first-steps-mobile" : "primeros-pasos-movil"}`,
);
const scenesDir = path.join(tutorialDir, "scenes");
mkdirSync(scenesDir, { recursive: true });
const loopback = path.join(repoRoot, "scripts", "tutorial-video", "loopback.py");
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const only = argv.filter((a) => !a.startsWith("--"));
const durations: Record<string, number> = (() => {
  try {
    return JSON.parse(readFileSync(path.join(tutorialDir, "narration", "durations.json"), "utf8"));
  } catch {
    return {};
  }
})();

const SESSION_NAME = UI_LANG === "en" ? "Sunday" : "Domingo";
const SONG = UI_LANG === "en" ? "Faithful" : "Fiel";
const FOLDER_NAME = UI_LANG === "en" ? "Monitors" : "Monitores";
const TITLES =
  UI_LANG === "en"
    ? { intro: ["Your first song in LibreTracks", "On phone and tablet"], end: ["libretracks.com", "The complete guide, button by button"] }
    : { intro: ["Tu primera canción en LibreTracks", "En el móvil y la tablet"], end: ["libretracks.com", "La guía completa, botón a botón"] };
const tour = (id: string) => `[data-lt-tour="${id}"]`;
const clickText = async (selector: string, text: string) =>
  run(
    (sel: string, t: string) => {
      const el = Array.from(document.querySelectorAll(sel)).find(
        (e) => (e.textContent ?? "").trim() === t && e.getBoundingClientRect().width > 0,
      ) as HTMLElement | undefined;
      el?.click();
      return Boolean(el);
    },
    selector,
    text,
  );

/** Types into the focused field through the IME, so it shows being written. */
function typeSlow(text: string) {
  for (const ch of text) adb(`shell input text "${ch === " " ? "%s" : ch}"`);
}

/** Puts the on-screen keyboard away (Back), only if it is up: with no
 * keyboard, Back would close the app's dialog instead. */
async function hideKeyboard() {
  const shown = /mInputShown=true/.test(adb("shell dumpsys input_method"));
  if (shown) {
    adb("shell input keyevent 4");
    await sleep(900);
  }
}

// ---- Recording -------------------------------------------------------------

type AudioClip = { at: number; wav: string };
let sceneStart = 0;
let audioClips: AudioClip[] = [];

/** Plays `ms` of real time while recording what the speaker plays. */
async function listen(ms: number) {
  if (dry) {
    await sleep(ms);
    return;
  }
  const wav = path.join(scenesDir, `.audio-${Date.now()}.wav`);
  const proc = spawn("python", [loopback, wav, String(ms / 1000 + 1)], { stdio: ["ignore", "pipe", "inherit"] });
  const start = await new Promise<number>((resolve, reject) => {
    let buf = "";
    proc.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /START ([0-9.]+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    proc.on("exit", () => reject(new Error("loopback recorder exited before starting")));
  });
  await sleep(ms);
  await new Promise((resolve) => proc.on("exit", resolve));
  audioClips.push({ at: start - sceneStart, wav });
}

async function scene(id: string, action: () => Promise<void>) {
  if (only.length && !only.includes(id)) return;
  console.log(`[tutorial] scene ${id}`);
  audioClips = [];
  if (dry) {
    await action();
    execSync(`${ADB} exec-out screencap -p > "${path.join(scenesDir, `${id}.dry.png`)}"`, { shell: "bash" as never });
    return;
  }
  const remote = `/sdcard/lt-scene.mp4`;
  adb(`shell rm -f ${remote}`);
  const rec = spawn(ADB.replace(/"/g, ""), ["shell", "screenrecord", "--bit-rate", "16000000", remote], {
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  // screenrecord takes a moment to produce its first frame; the scene clock
  // starts with it, which is what the audio offsets are measured against.
  await sleep(800);
  sceneStart = Date.now() / 1000;
  setTouchRipple(true);
  try {
    await action();
    // Hold the last picture for as long as the sentence needs.
    const want = (durations[id] ?? 0) + 1.2 - (Date.now() / 1000 - sceneStart);
    if (want > 0) await sleep(want * 1000);
  } finally {
    setTouchRipple(false);
  }
  const exited = new Promise((resolve) => rec.on("exit", resolve));
  adb(`shell "kill -2 $(pidof screenrecord)"`);
  await Promise.race([exited, sleep(10_000)]);
  await sleep(500);
  const raw = path.join(scenesDir, `.${id}.raw.mp4`);
  adb(`pull ${remote} "${raw}"`);
  // A phone is 20:9: fit it in 16:9 with the app's own background around it.
  execSync(
    `ffmpeg -y -loglevel error -i "${raw}" -vf "scale=1920:-2:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0d10,fps=30,setsar=1" ` +
      `-an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p "${path.join(scenesDir, `${id}.mp4`)}"`,
  );
  execSync(`rm -f "${raw}"`);
  if (audioClips.length) {
    const kept = audioClips.map((clip, i) => {
      const name = `${id}.audio-${i}.wav`;
      execSync(`mv "${clip.wav}" "${path.join(scenesDir, name)}"`);
      return { at: Math.max(0, clip.at), wav: name };
    });
    writeFileSync(path.join(scenesDir, `${id}.audio.json`), JSON.stringify(kept, null, 2));
  }
}

async function titleCard(title: string, sub: string) {
  await run(
    (t: string, s: string) => {
      const el = document.createElement("div");
      el.id = "lt-tutorial-title";
      el.style.cssText =
        "position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;" +
        "justify-content:center;background:rgba(8,10,12,.85);font-family:Inter,Segoe UI,sans-serif;color:#fff";
      el.innerHTML =
        `<div style="font-size:44px;font-weight:800;letter-spacing:-1px">${t}</div>` +
        `<div style="margin-top:14px;font-size:22px;color:#57f1db">${s}</div>`;
      document.body.appendChild(el);
    },
    title,
    sub,
  );
}
const removeTitleCard = () => run(() => document.getElementById("lt-tutorial-title")?.remove());

// ---- The scenes ------------------------------------------------------------

// The system picker follows the device, not the app: keep it landscape and in
// Spanish too, or it turns up sideways and in English mid-video. Both reset
// when the emulator restarts, so set them every run.
adb("shell settings put system accelerometer_rotation 0");
adb("shell settings put system user_rotation 1");
adb("shell cmd locale set-app-locales com.google.android.documentsui --locales es-ES");
adb("shell cmd media_session volume --stream 3 --set 15");
adb(`shell am force-stop ${APP}`);
if (!only.length || only.includes("01-intro")) adb(`shell pm clear ${APP}`);
adb(`shell cmd locale set-app-locales ${APP} --locales ${UI_LANG === "en" ? "en-US" : "es-ES"}`);
adb(`shell am start -n ${APP}/com.libretracks.desktop.MainActivity`);
await connect();
await send("Page.enable");
await sleep(12_000);
// First-run prompts out of the way.
for (const label of [L("No, gracias"), L("Saltar tutorial")]) {
  if (await rectOf("button", { text: label })) {
    await tap("button", { text: label });
    await sleep(800);
  }
}
console.log("[tutorial] viewport", JSON.stringify(await viewport()));
// Song arrangements are not announced yet: keep their menu entries off camera.
await run((label: string) => {
  const hide = () =>
    document.querySelectorAll("button").forEach((b) => {
      if ((b.textContent ?? "").trim().toLowerCase().startsWith(label)) (b as HTMLElement).style.display = "none";
    });
  hide();
  new MutationObserver(hide).observe(document.body, { childList: true, subtree: true });
}, L("Arreglo").toLowerCase());
// The voice guide speaks the video's language (pm clear reset it).
await run(async (lang: string) => {
  const invoke = (window as any).__TAURI_INTERNALS__.invoke;
  const settings = await invoke("get_settings");
  await invoke("update_audio_settings", { settings: { ...settings, voiceGuideLanguage: lang } });
}, UI_LANG);

await scene("01-intro", async () => {
  await titleCard(TITLES.intro[0], TITLES.intro[1]);
  await sleep(4000);
  await removeTitleCard();
  await sleep(1500);
});

await scene("02-crear", async () => {
  await tap(tour("landing-create"), { settle: 1200 });
  await run((ph: string) => (document.querySelector(`input[placeholder="${ph}"]`) as HTMLInputElement).focus(), L("Nombre de la sesion"));
  await sleep(900);
  typeSlow(SESSION_NAME);
  await sleep(900);
  await hideKeyboard();
  await tap("button", { text: L("Crear"), settle: 4000 });
  await waitFor("button", { text: L("Añadir audios") });
});

await scene("03-audios", async () => {
  await tap("button", { text: L("Añadir audios"), settle: 3500 });
  await uiTap("Audio");
  await sleep(800);
  const first = uiNodes().find((n) => n.text.endsWith(".wav"));
  if (!first) throw new Error("no audio in the picker");
  await uiTap(first.text, { holdMs: 900 });
  await uiTap("Más opciones");
  await uiTap("Seleccionar todo");
  await sleep(1200);
  await uiTap("Seleccionar");
  await waitFor("button", { text: "OK", timeout: 30_000 });
  await sleep(1500);
});

await scene("04-colocar", async () => {
  await tap("button", { text: "OK", settle: 1500 });
  // The tracks come in as their audio is prepared.
  await waitFor(".lt-region-hotspot", { timeout: 60_000 });
  await sleep(6000);
});

await scene("05-renombrar", async () => {
  await tap(".lt-region-hotspot", { settle: 1500 });
  await waitFor("button", { text: L("Renombrar Cancion") });
  await sleep(600);
  await tap("button", { text: L("Renombrar Cancion"), settle: 1200 });
  await waitFor("#lt-dialog-input");
  await run(() => (document.querySelector("#lt-dialog-input") as HTMLInputElement).select());
  await sleep(500);
  typeSlow(SONG);
  await sleep(800);
  await hideKeyboard();
  await tap("button", { text: "OK", settle: 1500 });
  const name = await run(() => document.querySelector(".lt-region-hotspot")?.textContent ?? "");
  if (!name.includes(SONG)) throw new Error(`05-renombrar: song is "${name}"`);
});

/** Screenshot for working out a scene (dry runs only). */
const peek = (name: string) => {
  if (dry) execSync(`${ADB} exec-out screencap -p > "${path.join(scenesDir, `peek-${name}.png`)}"`, { shell: "bash" as never });
};
/** Tags the header of the track called `name` (scrolling the list to it). */
async function headerOf(name: string) {
  const ok = await run((n: string) => {
    document.querySelectorAll("[data-tut]").forEach((e) => e.removeAttribute("data-tut"));
    const h = Array.from(document.querySelectorAll(".lt-track-header")).find(
      (e) => (e.querySelector(".lt-track-title-row strong")?.textContent ?? "").trim() === n,
    );
    h?.setAttribute("data-tut", n);
    return Boolean(h);
  }, name);
  if (!ok) throw new Error(`no track "${name}"`);
  return `[data-tut="${name}"]`;
}
const bar = ".lt-mobile-selection-actions";

/** Tags the visible element whose trimmed text is exactly `text`, scrolled into view. */
async function exact(selector: string, text: string) {
  const ok = await run(
    (sel: string, t: string) => {
      document.querySelectorAll("[data-tut-exact]").forEach((e) => e.removeAttribute("data-tut-exact"));
      const el = Array.from(document.querySelectorAll(sel)).find((e) => (e.textContent ?? "").trim() === t);
      el?.setAttribute("data-tut-exact", "1");
      el?.scrollIntoView({ block: "center" });
      return Boolean(el);
    },
    selector,
    text,
  );
  if (!ok) throw new Error(`no ${selector} "${text}"`);
  await sleep(400);
  return '[data-tut-exact="1"]';
}

await scene("06-nota", async () => {
  if (!(await rectOf(bar, { text: L("Nota de la cancion") }))) await tap(".lt-region-hotspot", { settle: 1500 });
  await tap("button", { text: L("Nota de la cancion"), settle: 1200 });
  await tap(await exact("button", "D"), { settle: 1500 });
  const key = await run(async () => {
    const view = (await (window as any).__TAURI_INTERNALS__.invoke("get_song_view")) as any;
    return String(view?.regions?.[0]?.key ?? "");
  });
  if (key !== "D") throw new Error(`06-nota: song key is "${key}"`);
});

await scene("07-tempo", async () => {
  await tap(`${bar} button[aria-label="${L("Quitar selección")}"]`, { settle: 800 });
  await tap(tour("topbar-tempo"), { settle: 1000 });
  await run(() => (document.querySelector(".lt-tempo-input") as HTMLInputElement | null)?.select());
  typeSlow("128");
  await sleep(600);
  adb("shell input keyevent 66"); // Enter
  await sleep(800);
  await hideKeyboard();
  await tap(`${tour("topbar-metronome")} > button:nth-of-type(1)`, { settle: 800 });
  await tap(`button[aria-label="${L("Reproducir")}"]`, { settle: 300 });
  await listen(7000);
  await tap(`button[aria-label="${L("Detener")}"]`, { settle: 800 });
  peek("07-after");
});

await scene("08-carpeta", async () => {
  const click = await headerOf("Click");
  await run(() => document.querySelector('[data-tut="Click"]')?.scrollIntoView({ block: "center" }));
  await sleep(600);
  await tap(`${click} .lt-track-title-row strong`, { settle: 1000 });
  await tap(`${bar} button[aria-label="${L("Seleccionar varias pistas")}"]`, { settle: 800 });
  const guia = await headerOf("Guia");
  await tap(`${guia} .lt-track-title-row strong`, { settle: 1000 });
  await tap(`${bar} button`, { text: L("Mover a carpeta"), settle: 1200 });
  peek("08-menu");
  await tap(await exact("button", L("Carpeta nueva…")), { settle: 1200 });
  await waitFor("#lt-dialog-input");
  await run(() => (document.querySelector("#lt-dialog-input") as HTMLInputElement).select());
  typeSlow(FOLDER_NAME);
  await sleep(700);
  await hideKeyboard();
  await tap("button", { text: "OK", settle: 1500 });
  const folder = await run(async (folderName: string) => {
    const view = (await (window as any).__TAURI_INTERNALS__.invoke("get_song_view")) as any;
    const f = view.tracks.find((t: any) => t.name === folderName);
    return f ? view.tracks.filter((t: any) => t.parentTrackId === f.id).map((t: any) => t.name).join(",") : "";
  }, FOLDER_NAME);
  if (folder !== "Click,Guia") throw new Error(`08-carpeta: folder holds "${folder}"`);
  peek("08-done");
});

await scene("09-marcas", async () => {
  if (await rectOf(`${bar} button[aria-label="${L("Quitar selección")}"]`)) await tap(`${bar} button[aria-label="${L("Quitar selección")}"]`, { settle: 800 });
  await tap(`${bar} button`, { text: L("Sección"), settle: 1200 });
  await tap(await exact("button", L("Intro")), { settle: 1500 });
  // Move the cursor with a tap on the ruler, a fifth into the song.
  const song = await rectOf(".lt-region-hotspot");
  const ruler = await rectOf(tour("timeline-ruler"));
  if (!song || !ruler) throw new Error("09-marcas: no ruler");
  await touch(song.x + song.w * 0.2, ruler.y + ruler.h * 0.6);
  await sleep(1200);
  peek("09-cursor");
  await tap(`${bar} button`, { text: L("Sección"), settle: 1200 });
  await tap(await exact("button", `${L("Verso")} ▸`), { settle: 1200 });
  await tap(await exact("button", L("Verso")), { settle: 1500 });
  await touch(song.x + song.w * 0.4, ruler.y + ruler.h * 0.6);
  await sleep(1200);
  await tap(`${bar} button`, { text: L("Sección"), settle: 1200 });
  await tap(await exact("button", `${L("Coro")} ▸`), { settle: 1200 });
  await tap(await exact("button", L("Coro")), { settle: 1500 });
  // A cue for the band, just before the verse.
  await touch(song.x + song.w * 0.14, ruler.y + ruler.h * 0.6);
  await sleep(1200);
  await tap(`${bar} button`, { text: L("Aviso"), settle: 1200 });
  await tap(await exact("button", L("Toda La Banda")), { settle: 1500 });
  const markers = await run(async () => {
    const view = (await (window as any).__TAURI_INTERNALS__.invoke("get_song_view")) as any;
    return (view.sectionMarkers ?? view.markers ?? []).map((m: any) => m.name).join(",");
  });
  console.log(`[tutorial] markers: ${markers}`);
  peek("09-done");
});

await scene("10-guia", async () => {
  await tap(`${tour("topbar-voice-guide")} > button:nth-of-type(1)`, { settle: 1000 });
  // From a couple of bars before the chorus, to hear it announced.
  const song = await rectOf(".lt-region-hotspot");
  const ruler = await rectOf(tour("timeline-ruler"));
  if (!song || !ruler) throw new Error("10-guia: no ruler");
  await touch(song.x + song.w * 0.33, ruler.y + ruler.h * 0.6);
  await sleep(1000);
  await tap(`button[aria-label="${L("Reproducir")}"]`, { settle: 300 });
  await listen(8000);
  await tap(`button[aria-label="${L("Detener")}"]`, { settle: 800 });
});

await scene("11-live", async () => {
  await tap(`${tour("view-mode-switcher")} button:nth-of-type(3)`, { settle: 2000 });
  peek("11-live");
  await tap(`button[aria-label="${L("Reproducir")}"]`, { settle: 300 });
  await listen(2500);
  await tap("button", { text: L("Coro"), settle: 300 });
  await listen(5000);
  await tap(`button[aria-label="${L("Detener")}"]`, { settle: 800 });
});

await scene("12-final", async () => {
  await tap(`${tour("view-mode-switcher")} button:nth-of-type(1)`, { settle: 1500 });
  await tap(`button[aria-label="${L("Guardar")}"]`, { settle: 1500 });
  await titleCard(TITLES.end[0], TITLES.end[1]);
  await sleep(4000);
});

disconnect();
process.exit(0);
