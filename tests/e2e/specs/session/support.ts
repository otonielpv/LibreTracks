import { browser, $, $$ } from "@wdio/globals";
import { writeFileSync } from "node:fs";
import { Key } from "webdriverio";
import AppPage, {
  type E2ESongView,
} from "../../pageobjects/app.page.js";

export const AUDIO_FILE_NAME = "e2e-tone.wav";
export const UNUSED_AUDIO_FILE_NAME = "e2e-unused.wav";

export type SessionFixture = {
  sessionParentDir: string;
  audioFilePath: string;
  unusedAudioFilePath: string;
  sessionFilePath: string;
  initialMetronomeEnabled: boolean | null;
};

/** Fundamental frequency of the WAV fixture written by writeToneWav. */
export const TONE_FREQUENCY_HZ = 440;

/**
 * Write a small PCM WAV fixture that the real native decoder can import.
 *
 * `sampleRate` defaults to 44.1k (what every existing fixture assumes); pass
 * something else to build a session whose audio does not match the engine rate.
 */
export function writeToneWav(
  filePath: string,
  durationSeconds = 5,
  sampleRate = 44_100,
) {
  const sampleCount = sampleRate * durationSeconds;
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(
      Math.sin((index * 2 * Math.PI * TONE_FREQUENCY_HZ) / sampleRate) * 4_000,
    );
    wav.writeInt16LE(sample, 44 + index * 2);
  }
  writeFileSync(filePath, wav);
}

/**
 * In-place iterative radix-2 Cooley–Tukey FFT (`re`/`im` length N, power of two).
 * Used only by dominantFrequency below — small enough to keep local to the tests
 * rather than pull in a dependency.
 */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Estimate the dominant frequency (Hz) of a real mono signal via a Hann-windowed
 * FFT with parabolic peak interpolation. Validated to sub-Hz accuracy on
 * synthetic 440/660/880 Hz tones. Returns 0 for an empty/too-short signal.
 */
export function dominantFrequency(
  samples: number[] | Float32Array,
  sampleRate: number,
): number {
  if (!samples.length || sampleRate <= 0) {
    return 0;
  }
  let n = 1;
  while (n * 2 <= samples.length) n *= 2;
  if (n < 2) {
    return 0;
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
    re[i] = samples[i] * w;
  }
  fft(re, im);
  const half = n / 2;
  let peak = 1;
  let peakMag = 0;
  for (let k = 1; k < half; k += 1) {
    const mag = re[k] * re[k] + im[k] * im[k];
    if (mag > peakMag) {
      peakMag = mag;
      peak = k;
    }
  }
  const magAt = (k: number) => Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  const a = magAt(peak - 1);
  const b = magAt(peak);
  const c = magAt(peak + 1);
  const delta = (0.5 * (a - c)) / (a - 2 * b + c || 1);
  return ((peak + delta) * sampleRate) / n;
}

/** Open the context menu at a clip's rendered position after timeline fitting. */
export async function openClipContextMenu(
  clip: E2ESongView["clips"][number],
) {
  await browser.execute(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const lane = await AppPage.trackLane(clip.trackId);
  const laneSize = await lane.getSize();
  const timelineView = await AppPage.timelineView();
  const pixelsPerSecond = timelineView.zoomLevel * 18;
  const clipCenterFromLeft =
    clip.timelineStartSeconds * pixelsPerSecond -
    timelineView.cameraX +
    Math.min((clip.durationSeconds * pixelsPerSecond) / 2, 12);
  await lane.click({
    button: "right",
    x: Math.round(clipCenterFromLeft - laneSize.width / 2),
    y: 0,
  });
  const menu = await $(".lt-context-menu");
  await menu.waitForDisplayed();
  return menu;
}

/** Send a real W3C Ctrl+wheel gesture while keeping both input sources aligned. */
export async function zoomTimelineWithWheel(
  origin: ReturnType<typeof $>,
  deltaY: number,
) {
  const keyboard = browser
    .action("key")
    .down(Key.Ctrl)
    .pause(100)
    .up(Key.Ctrl);
  const wheel = browser
    .action("wheel")
    .pause(20)
    .scroll({ origin, deltaX: 0, deltaY, duration: 50 })
    .pause(30);
  await browser.actions([keyboard, wheel]);
}

/**
 * Select a region and set its transpose to an absolute semitone value by
 * stepping the toolbar's +/- buttons (more reliable in this WebView than the
 * number input, which has the same clearValue caveat). Re-selecting the region
 * matters because playback/seek can drop the selection and collapse the stepper.
 *
 * `regionIndex` is an index into the MODEL's `song.regions`, and the hotspot is
 * matched to that region by id — not by DOM order. Getting this wrong is subtle
 * and was a real bug here: the helper used to click `hotspots[0]` while reading
 * `regions[0]`, two orderings that only agree while a session has ONE region.
 * Once `session.e2e.ts` had accumulated two (17-19 s and 25-30 s), it stepped
 * one region and asserted on the other, so the transposed audio was never the
 * audio being measured and the pitch test read an unshifted 440 Hz.
 */
export async function setRegionTranspose(semitones: number, regionIndex = 0) {
  const targetId = (await AppPage.songView())?.regions[regionIndex]?.id;
  if (!targetId) {
    throw new Error(`No region at index ${regionIndex} to transpose`);
  }

  await (await regionHotspot(targetId, regionIndex)).click();

  const trigger = await $(
    'button[aria-label="Transposicion de Region settings"]',
  );
  await trigger.waitForClickable({ timeout: 15_000 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }

  const up = await $(
    'button[aria-label="Subir un semitono la region seleccionada"]',
  );
  const down = await $(
    'button[aria-label="Bajar un semitono la region seleccionada"]',
  );
  await up.waitForDisplayed({ timeout: 15_000 });

  // Track the region by ID: a transpose resizes it (varispeed halves the
  // duration at +12), which can reorder `song.regions`.
  const current = () =>
    AppPage.songView().then(
      (song) =>
        song?.regions.find((region) => region.id === targetId)
          ?.transposeSemitones ?? 0,
    );
  for (let guard = 0; guard < 30; guard += 1) {
    const value = await current();
    if (value === semitones) {
      break;
    }
    await (value < semitones ? up : down).click();
    await browser.waitUntil(async () => (await current()) !== value, {
      timeout: 10_000,
      timeoutMsg: "Transpose step did not register in the model",
    });
  }
}

/**
 * Seek into `trackId`'s clip, play, capture the final mixed output, and return
 * its dominant frequency (Hz). Stops the transport afterwards. The caller is
 * responsible for isolating the track (solo/mute) so the captured output is that
 * track's signal — the capture is the whole output bus.
 */
export async function measureRenderedPitch(trackId: string): Promise<number> {
  const clip = (await AppPage.songView())?.clips.find(
    (c) => c.trackId === trackId,
  );
  if (!clip) {
    throw new Error(`No clip on track ${trackId} to measure`);
  }

  const timelineView = await AppPage.timelineView();
  const ruler = await AppPage.timelineRuler;
  const rulerSize = await ruler.getSize();
  const pixelsPerSecond = timelineView.zoomLevel * 18;
  const seekSeconds =
    clip.timelineStartSeconds + Math.min(clip.durationSeconds / 2, 1);
  const seekFromLeft = seekSeconds * pixelsPerSecond - timelineView.cameraX;
  await ruler.click({ x: Math.round(seekFromLeft - rulerSize.width / 2), y: 0 });

  await (await AppPage.playButton).click();
  await AppPage.waitForTrackSignal(trackId);
  // Let the capture ring fill with the (possibly transposed) audio.
  await browser.pause(400);

  const capture = await AppPage.audioOutputCapture();
  await (await AppPage.stopButton).click();
  await browser.waitUntil(
    async () => (await AppPage.transportSnapshot()).playbackState === "stopped",
    { timeoutMsg: "Engine did not stop after pitch measurement" },
  );

  const channel =
    capture.left.length >= capture.right.length ? capture.left : capture.right;
  if (channel.length < 2048) {
    throw new Error("Captured output was too short to analyze");
  }
  return dominantFrequency(channel, capture.sampleRate);
}

/**
 * Enable or disable warp on the currently selected region via the toolbar's
 * "Warp de Region" popover. Warp matters for transpose semantics: WITHOUT warp,
 * a pitch change is global vari-speed (resampling) that shifts every track
 * regardless of its per-track "T"; the per-track transpose-enable flag only has
 * an effect when warp is on. Re-selects the region first (playback can drop it).
 */
export async function setRegionWarp(enabled: boolean, regionIndex = 0) {
  const targetId = (await AppPage.songView())?.regions[regionIndex]?.id;
  if (!targetId) {
    throw new Error(`No region at index ${regionIndex} to warp`);
  }
  await (await regionHotspot(targetId, regionIndex)).click();

  const trigger = await $('button[aria-label="Warp de Region settings"]');
  await trigger.waitForClickable({ timeout: 15_000 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }

  const toggle = await $(
    'button[aria-label="Activar warp en la region seleccionada"]',
  );
  await toggle.waitForDisplayed({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-pressed")) !== String(enabled)) {
    await toggle.click();
  }
  await browser.waitUntil(
    async () =>
      ((await AppPage.songView())?.regions.find((r) => r.id === targetId)
        ?.warpEnabled ?? false) === enabled,
    {
      timeout: 30_000,
      timeoutMsg: `Region warp did not become ${enabled} in the model`,
    },
  );
}

/**
 * The hotspot for a specific region, addressed by id.
 *
 * Region hotspots render in VISUAL order while `song.regions` is a separate
 * list — clicking `hotspots[i]` to act on `regions[i]` only works while there
 * is exactly one region, and silently targets the wrong one after that. Every
 * region helper goes through here so that class of bug stays fixed.
 */
async function regionHotspot(regionId: string, fallbackIndex: number) {
  const hotspots = await $$(".lt-region-hotspot").getElements();
  for (const hotspot of hotspots) {
    if ((await hotspot.getAttribute("data-region-id")) === regionId) {
      return hotspot;
    }
  }
  const fallback = hotspots[fallbackIndex] ?? hotspots[0];
  if (!fallback) {
    throw new Error("No region hotspot rendered");
  }
  return fallback;
}

/**
 * Set the selected region's warp source BPM via its context menu ("Cambiar BPM
 * original"), which opens a prompt dialog. The warp ratio is (timeline BPM /
 * source BPM), so a source of 60 against the default 120 BPM timeline stretches
 * the audio 2×. Region must have warp enabled for this to affect playback.
 */
export async function setRegionWarpSourceBpm(bpm: number, regionIndex = 0) {
  const targetId = (await AppPage.songView())?.regions[regionIndex]?.id;
  if (!targetId) {
    throw new Error(`No region at index ${regionIndex} to set warp BPM on`);
  }
  const hotspot = await regionHotspot(targetId, regionIndex);
  await hotspot.click({ button: "right" });
  const menu = await $(".lt-context-menu");
  await menu.waitForDisplayed();
  const entry = await menu.$("button*=Cambiar BPM original");
  await entry.waitForClickable({ timeout: 15_000 });
  await entry.click();

  const input = await $("#lt-dialog-input");
  await input.waitForDisplayed({ timeout: 15_000 });
  await input.click();
  await browser.keys(["Control", "a"]);
  await browser.keys(["Backspace"]);
  await browser.keys(String(bpm));
  await (await $(".lt-dialog-button--primary")).click();

  await browser.waitUntil(
    async () =>
      Math.abs(
        ((await AppPage.songView())?.regions.find((r) => r.id === targetId)
          ?.warpSourceBpm ?? 0) - bpm,
      ) < 0.5,
    {
      timeout: 30_000,
      timeoutMsg: `Region warp source BPM did not reach ${bpm} in the model`,
    },
  );
}

/** Toggle a track's solo button ("S") in its header row. */
export async function toggleTrackSolo(trackId: string) {
  const header = await $(`.lt-track-header-row[data-track-id="${trackId}"]`);
  const soloButton = await header.$("button=S");
  await soloButton.waitForClickable({ timeout: 15_000 });
  await soloButton.click();
}

/** Toggle a track's transpose-enable button ("T") in its header row. */
export async function toggleTrackTranspose(trackId: string) {
  const header = await $(`.lt-track-header-row[data-track-id="${trackId}"]`);
  const tButton = await header.$("button=T");
  await tButton.waitForClickable({ timeout: 15_000 });
  await tButton.click();
}

/**
 * Return one track to a neutral mix: solo off, mute off, unity volume, centre
 * pan. Drives the same header controls a user would (double-click resets a
 * fader to its default), so it exercises production paths rather than poking
 * the model.
 *
 * Flows that measure the output bus with an FFT depend on every OTHER track
 * being neutral — a soloed or hard-panned leftover corrupts the capture and
 * the failure appears in an unrelated test later on.
 */
export async function resetTrackMix(trackId: string) {
  const header = await $(`.lt-track-header-row[data-track-id="${trackId}"]`);
  const state = () =>
    AppPage.songView().then((song) =>
      song?.tracks.find((track) => track.id === trackId),
    );

  if ((await state())?.solo) {
    await toggleTrackSolo(trackId);
  }
  if ((await state())?.muted) {
    const muteButton = await header.$("button=M");
    await muteButton.waitForClickable({ timeout: 15_000 });
    await muteButton.click();
  }
  if ((await state())?.volume !== 1) {
    const volume = await header.$(".lt-track-volume input");
    await volume.doubleClick();
  }
  if ((await state())?.pan !== 0) {
    const pan = await header.$(".lt-track-pan input");
    await pan.doubleClick();
  }
}
