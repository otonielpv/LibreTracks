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
      Math.sin((index * 2 * Math.PI * 440) / sampleRate) * 4_000,
    );
    wav.writeInt16LE(sample, 44 + index * 2);
  }
  writeFileSync(filePath, wav);
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
