import { browser, expect, $$ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import {
  AUDIO_FILE_NAME,
  TONE_FREQUENCY_HZ,
  measureRenderedPitch,
  setRegionTranspose,
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
