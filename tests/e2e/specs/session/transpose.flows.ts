import { browser, expect, $, $$ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import {
  AUDIO_FILE_NAME,
  TONE_FREQUENCY_HZ,
  dominantFrequency,
} from "./support.js";

/**
 * Transpose is NOT metadata like region key — it time-stretches/pitch-shifts the
 * region's audio through the real Bungee voice. So this flow proves it by MEASURING
 * the rendered signal, not the badge: the 440 Hz tone fixture, transposed +12
 * semitones, must come out ~880 Hz. We capture the final mixed output from the
 * engine (window.__ltE2E.getAudioOutputCapture) and FFT it in Node.
 *
 * The whole point of the output-capture instrumentation is this test — asserting
 * an audio-affecting edit actually changed the audio.
 */
export function registerSessionTransposeFlows() {
  it("shifts the rendered pitch when a region is transposed", async () => {
    // 1. Ensure a track with the 440 Hz tone clip exists, inside a region.
    const track = await ensureAudioTrackWithClip();

    // 2. Select the region so the toolbar transpose control enables.
    const hotspots = await $$(".lt-region-hotspot").getElements();
    expect(hotspots.length).toBeGreaterThan(0);
    await hotspots[0].click();

    // 3. Measure the rendered pitch BEFORE transposing (baseline ~440 Hz).
    const baseHz = await measureRenderedPitch(track.id);
    expect(Math.abs(baseHz - TONE_FREQUENCY_HZ)).toBeLessThan(30);

    // 4. Set +12 semitones via the toolbar stepper input.
    await setRegionTranspose(12);
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.regions.some(
          (region) => region.transposeSemitones === 12,
        ) === true,
      {
        timeout: 30_000,
        timeoutMsg: "Transpose +12 never reached the backend song model",
      },
    );

    // 5. Measure again: +12 semitones is one octave, so ~880 Hz. Allow a wide
    // tolerance — the pitch backend is not a perfect resampler, but an octave is
    // unmistakable versus the 440 Hz baseline.
    const shiftedHz = await measureRenderedPitch(track.id);
    expect(shiftedHz).toBeGreaterThan(700);
    expect(shiftedHz).toBeLessThan(1050);

    // Reset transpose so later flows start from a neutral region.
    await setRegionTranspose(0);
  });
}

/** Guarantee a track named for this flow with the tone clip placed on it. */
async function ensureAudioTrackWithClip() {
  let song = await AppPage.songView();
  let track = song?.tracks.find((t) => t.name === "E2E Audio Track");
  if (!track) {
    throw new Error(
      "E2E Audio Track missing — audio.flows.ts must run before transpose.flows.ts",
    );
  }
  // Place the tone clip if the track has none.
  const hasClip = (song?.clips ?? []).some((c) => c.trackId === track!.id);
  if (!hasClip) {
    const asset = await AppPage.libraryAsset(AUDIO_FILE_NAME);
    const lane = await AppPage.trackLane(track.id);
    await asset.dragAndDrop(lane);
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.clips.some((c) => c.trackId === track!.id) ===
        true,
      { timeout: 60_000, timeoutMsg: "Tone clip was never placed for transpose" },
    );
    song = await AppPage.songView();
    track = song?.tracks.find((t) => t.name === "E2E Audio Track");
  }
  if (!track) {
    throw new Error("Audio track disappeared while preparing transpose flow");
  }
  return track;
}

/**
 * Set the region's transpose to an absolute semitone value by stepping the
 * toolbar's +/- buttons (more reliable in this WebView than the number input,
 * which has the same clearValue caveat as other inputs). Reads the current
 * value from the backend model and steps the difference.
 */
async function setRegionTranspose(semitones: number) {
  // Re-select the region: playing/seeking during a measurement can clear the
  // selection, which collapses the stepper to a "select a region" message.
  const hotspots = await $$(".lt-region-hotspot").getElements();
  if (hotspots.length) {
    await hotspots[0].click();
  }

  // Open the collapsible ControlGroup popover if it isn't open yet — its
  // trigger is labelled "<title> settings" and reflects state via aria-expanded.
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

  const current = () =>
    AppPage.songView().then(
      (song) => song?.regions[0]?.transposeSemitones ?? 0,
    );
  // Step toward the target, re-reading the model each step so we don't overshoot
  // the [-12, 12] clamp the UI enforces.
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
 * Seek into the clip, play, capture the final output, and return its dominant
 * frequency. Stops the transport afterwards.
 */
async function measureRenderedPitch(trackId: string): Promise<number> {
  const clip = (await AppPage.songView())?.clips.find(
    (c) => c.trackId === trackId,
  );
  if (!clip) {
    throw new Error("No clip on the audio track to measure");
  }

  // Seek to the middle of the clip via the ruler (reusing the audio-flow math).
  const timelineView = await AppPage.timelineView();
  const ruler = await AppPage.timelineRuler;
  const rulerSize = await ruler.getSize();
  const pixelsPerSecond = timelineView.zoomLevel * 18;
  const seekSeconds =
    clip.timelineStartSeconds + Math.min(clip.durationSeconds / 2, 1);
  const seekFromLeft = seekSeconds * pixelsPerSecond - timelineView.cameraX;
  await ruler.click({ x: Math.round(seekFromLeft - rulerSize.width / 2), y: 0 });

  await (await AppPage.playButton).click();
  // Wait for real signal on the track so the capture ring holds tone, not silence.
  await AppPage.waitForTrackSignal(trackId);
  // Let the ring fill with post-transpose audio.
  await browser.pause(400);

  const capture = await AppPage.audioOutputCapture();
  await (await AppPage.stopButton).click();
  await browser.waitUntil(
    async () => (await AppPage.transportSnapshot()).playbackState === "stopped",
    { timeoutMsg: "Engine did not stop after pitch measurement" },
  );

  // Use the louder channel; the tone is mono so both carry it.
  const channel =
    capture.left.length >= capture.right.length ? capture.left : capture.right;
  expect(channel.length).toBeGreaterThan(2048);
  return dominantFrequency(channel, capture.sampleRate);
}
