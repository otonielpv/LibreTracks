import { browser, $ } from "@wdio/globals";
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

/** Write a small PCM WAV fixture that the real native decoder can import. */
export function writeToneWav(filePath: string, durationSeconds = 5) {
  const sampleRate = 44_100;
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
