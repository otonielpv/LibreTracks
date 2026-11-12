// Records the MOBILE scenes of the release video (docs/RELEASE_PROCESS.md
// step 11a) on the Android emulator, the sibling of
// tests/e2e/specs/release-video.e2e.ts. Rewritten every release for that
// release's feature; this one is 1.14.0: song arrangements on the phone.
//
//   LT_TUTORIAL_DIR=marketing/video-1.14.0 node tests/android/release-video/record.ts [--dry] [scene...]
//
// --dry runs the actions with a screenshot per scene instead of recording.
// Needs the DEBUG APK (DevTools) on the AVD, like the guide shots. The run
// clears the app's data and opens the bundled demo song, which has its
// sections marked; nothing here plays audio, so no borrowed sound is needed.
import { execSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
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
  viewport,
  waitFor,
} from "../lib/device.ts";
import { L } from "../../e2e/utils/uiText.ts";

const tutorialDir = path.resolve(process.env.LT_TUTORIAL_DIR ?? "marketing/video-1.14.0");
const scenesDir = path.join(tutorialDir, "scenes");
mkdirSync(scenesDir, { recursive: true });
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
const TITLES = { mobile: ["Y en el móvil", "Arreglos, MIDI, vídeo y más, en el teléfono y la tablet"], end: ["libretracks.com", "Gratis en Windows, macOS, Linux, Android e iOS"] };
const tour = (id: string) => `[data-lt-tour="${id}"]`;

// ---- Recording -------------------------------------------------------------

async function scene(id: string, action: () => Promise<void>) {
  if (only.length && !only.includes(id)) {
    await action();
    return;
  }
  console.log(`[release-video] scene ${id}`);
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
  await sleep(800);
  const start = Date.now() / 1000;
  setTouchRipple(true);
  try {
    await action();
    // Hold the last picture for as long as the sentence needs.
    const want = (durations[id] ?? 0) + 1.2 - (Date.now() / 1000 - start);
    if (want > 0) await sleep(want * 1000);
  } finally {
    setTouchRipple(false);
  }
  // Stop it ON the device first, or the MP4 has no index.
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

adb("shell settings put system accelerometer_rotation 0");
adb("shell settings put system user_rotation 1");
adb(`shell am force-stop ${APP}`);
adb(`shell pm clear ${APP}`);
adb(`shell cmd locale set-app-locales ${APP} --locales es-ES`);
adb(`shell am start -n ${APP}/com.libretracks.desktop.MainActivity`);
await connect();
await send("Page.enable");
await sleep(12_000);
for (const label of [L("No, gracias"), L("Saltar tutorial")]) {
  if (await rectOf("button", { text: label })) {
    await tap("button", { text: label });
    await sleep(800);
  }
}
console.log("[release-video] viewport", JSON.stringify(await viewport()));
// Bluetooth already allowed, as for anyone who accepted it once: the system
// prompt is in the device language and is not what the scene is about.
for (const perm of ["BLUETOOTH_SCAN", "BLUETOOTH_CONNECT"]) {
  try {
    adb(`shell pm grant ${APP} android.permission.${perm}`);
  } catch {
    /* older Android: nothing to grant */
  }
}
await tap(tour("landing-demo-song"));
await waitFor(".lt-timeline-shell", { timeout: 30_000 });
await sleep(6000);

await scene("13-movil", async () => {
  await titleCard(TITLES.mobile[0], TITLES.mobile[1]);
  await sleep(Math.max(2500, (durations["13-movil"] ?? 3) * 1000 - 800));
  await removeTitleCard();
  await sleep(800);
});

await scene("14-movil-arreglo", async () => {
  await longPress(".lt-region-hotspot", { nth: 0 });
  await sleep(1200);
  await tap(".lt-context-menu button", { text: L("Arreglo"), settle: 1500 });
  await waitFor(".lt-structure-mobile", { timeout: 10_000 });
  if (await rectOf(".lt-structure-capture-button")) {
    await sleep(1200);
    await tap(".lt-structure-capture-button", { settle: 1800 });
  }
  await run(() => document.querySelector(".lt-structure-add-row")?.scrollIntoView({ block: "center", behavior: "smooth" }));
  await sleep(1200);
  await tap(".lt-structure-add-row", { settle: 1500 });
  await waitFor(".lt-structure-tap-palette", { timeout: 5_000 });
  // The chorus («Estribillo» in the demo song), twice.
  const chorus = (await rectOf(".lt-structure-tap-row", { text: "Estribillo" }))
    ? { text: "Estribillo" }
    : { nth: 1 };
  await tap(".lt-structure-tap-row", { ...chorus, settle: 900 });
  await tap(".lt-structure-tap-row", { ...chorus, settle: 1200 });
  await tap(".lt-structure-sheet-footer .is-primary", { settle: 1500 });
  if (await rectOf(".lt-structure-mobile .is-primary.is-attention")) {
    await tap(".lt-structure-mobile .is-primary.is-attention", { settle: 2500 });
  }
  // Applying closes the editor and shows the song with its arrangement.
  await sleep(2500);
  if (await rectOf(".lt-structure-mobile")) {
    await tap(".lt-structure-mobile-header .lt-structure-icon-button", { nth: 0, settle: 2500 });
  }
});

await scene("15-movil-midi-pista", async () => {
  // A MIDI track and a message on it, with no MIDI device connected: the
  // messages are prepared in the song and go out through whatever port is
  // chosen later.
  const clear = `button[aria-label="${L("Quitar selección")}"]`;
  if (await rectOf(clear)) await tap(clear, { settle: 1000 });
  await tap(".lt-track-header .lt-track-title-row strong", { nth: 0, settle: 1400 });
  await tap(`.lt-mobile-selection-actions button[aria-label="${L("Más acciones")}"]`, { settle: 1600 });
  // The track menu is longer than a phone screen: bring the item up first.
  await run((needle: string) => {
    const el = Array.from(document.querySelectorAll(".lt-context-menu button")).find((b) =>
      (b.textContent ?? "").includes(needle),
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, L("Añadir pista MIDI"));
  await sleep(1200);
  await tap(".lt-context-menu button", { text: L("Añadir pista MIDI"), settle: 1800 });
  // The name prompt comes up with «MIDI» already in it: just confirm.
  await waitFor("#lt-dialog-input", { timeout: 5_000 });
  await sleep(800);
  await run(() => (document.querySelector("#lt-dialog-input") as HTMLInputElement | null)?.blur());
  await sleep(800);
  await tap("button", { text: L("OK"), settle: 2200 });
  if (await rectOf(clear)) await tap(clear, { settle: 1000 });
  // Its name, not the middle of the header (power button and port badge).
  await tap(".lt-track-header .lt-midi-header-text strong", { settle: 1400 });
  // «Añadir MIDI aquí» goes where the playhead is. The first song carries the
  // arrangement of the scene before, and adding clips to it asks to edit the
  // original first: use the second song.
  await run(async () => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke;
    const view = await invoke("get_song_view");
    const songs = [...view.regions].sort((x: any, y: any) => x.startSeconds - y.startSeconds);
    const target = songs[1] ?? songs[0];
    await invoke("seek_transport", { positionSeconds: target.startSeconds + 2 });
  });
  await sleep(1200);
  await tap(".lt-mobile-selection-actions button", { text: L("Añadir MIDI aquí"), settle: 2200 });
  await waitFor(".lt-midi-add-control", { timeout: 8_000 });
  // «Añadir mensaje» sits below the fold of the dialog on a phone.
  await run(() => document.querySelector(".lt-midi-add-control")?.scrollIntoView({ block: "center", behavior: "smooth" }));
  await sleep(1200);
  await tap(".lt-midi-add-control .is-primary", { settle: 2200 });
  await tap(".lt-automation-modal-actions .is-primary", { settle: 2200 });
  if (await rectOf(".lt-midi-add-control")) throw new Error("15-movil-midi-pista: the MIDI editor did not save");
  if (await rectOf(clear)) await tap(clear, { settle: 1000 });
});

await scene("16-movil-midi", async () => {
  await tap(tour("side-nav-settings"), { settle: 1500 });
  // MIDI folds under its own sidebar group; opening it shows the MIDI tab.
  if (await rectOf("#lt-settings-tab-midi")) await tap("#lt-settings-tab-midi", { settle: 1500 });
  else await tap("#lt-settings-group-midi", { settle: 1500 });
  const bluetooth = { text: L("Buscar dispositivos Bluetooth") };
  if (await rectOf("button", bluetooth)) {
    await run((needle: string) => {
      const el = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(needle));
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, bluetooth.text);
    await sleep(1200);
    // The emulator has no Bluetooth: the search shows what a phone without a
    // pedal nearby shows. Close it after a moment.
    await tap("button", { ...bluetooth, settle: 3500 });
    if (await rectOf(".lt-modal-backdrop, .lt-context-menu")) {
      adb("shell input keyevent 4");
      await sleep(1000);
    }
  }
  if (await rectOf("#lt-settings-tab-midiLearn")) await tap("#lt-settings-tab-midiLearn", { settle: 2500 });
  adb("shell input keyevent 4");
  await sleep(1200);
});

await scene("17-movil-video", async () => {
  // The song selected in the arrangement scene owns the bottom bar: clear it
  // so «Más acciones» is the Add sheet.
  const clear = `button[aria-label="${L("Quitar selección")}"]`;
  if (await rectOf(clear)) await tap(clear, { settle: 1200 });
  await tap(`button[aria-label="${L("Más acciones")}"]`, { settle: 2500 });
  adb("shell input keyevent 4");
  await sleep(1000);
  await tap(tour("side-nav-settings"), { settle: 1500 });
  if (await rectOf("#lt-settings-tab-video")) await tap("#lt-settings-tab-video", { settle: 3500 });
  adb("shell input keyevent 4");
  await sleep(1200);
});

await scene("18-movil-nivelar", async () => {
  await tap(tour("mobile-file-actions"), { settle: 1800 });
  const level = { text: L("Nivelar volumen de canciones") };
  if (await rectOf("button", level)) await tap("button", { ...level, settle: 2500 });
  adb("shell input keyevent 4");
  await sleep(1000);
});

await scene("19-final", async () => {
  await titleCard(TITLES.end[0], TITLES.end[1]);
  await sleep(4000);
});

disconnect();
process.exit(0);
