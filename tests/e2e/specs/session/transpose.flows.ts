import { browser, expect } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import {
  AUDIO_FILE_NAME,
  TONE_FREQUENCY_HZ,
  measureRenderedPitch,
  setRegionTranspose,
  toggleTrackSolo,
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

    // 2. Isolate this track. `measureRenderedPitch` captures the whole output
    // BUS, so any other sounding track lands in the same FFT. By this point
    // mix.flows.ts has added "E2E Solo Peer" with its own 440 Hz clip and never
    // removes it — without solo the peer's untransposed 440 Hz dominates the
    // spectrum and the measurement reads 440 even though this track really is
    // shifted to 880. (Verified in isolation: 439.95 Hz -> 880.04 Hz.)
    await toggleTrackSolo(track.id);
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find((t) => t.id === track.id)
          ?.solo === true,
      { timeout: 30_000, timeoutMsg: "Solo never reached the model" },
    );

    // 3. Find the region that actually CONTAINS this track's clip. Earlier
    // flows leave several regions behind, and neither "the first hotspot" nor
    // "regions[0]" is reliably the one holding the clip we measure — targeting
    // the wrong one transposes audio nobody is listening to, which is exactly
    // how this test used to read an unshifted 440 Hz while the feature worked.
    const songBefore = await AppPage.songView();
    const clip = songBefore?.clips.find((c) => c.trackId === track.id);
    if (!clip) {
      throw new Error("The measured track lost its clip before transposing");
    }
    const regionIndex = (songBefore?.regions ?? []).findIndex(
      (region) =>
        clip.timelineStartSeconds >= region.startSeconds &&
        clip.timelineStartSeconds < region.endSeconds,
    );
    if (regionIndex < 0) {
      throw new Error(
        `No region contains the clip at ${clip.timelineStartSeconds}s`,
      );
    }
    const regionId = songBefore!.regions[regionIndex]!.id;

    // 4. Measure the rendered pitch BEFORE transposing (baseline ~440 Hz).
    const baseHz = await measureRenderedPitch(track.id);
    expect(Math.abs(baseHz - TONE_FREQUENCY_HZ)).toBeLessThan(30);

    // 5. Set +12 semitones on THAT region via the toolbar stepper.
    await setRegionTranspose(12, regionIndex);
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.regions.find(
          (region) => region.id === regionId,
        )?.transposeSemitones === 12,
      {
        timeout: 30_000,
        timeoutMsg: "Transpose +12 never reached the clip's region",
      },
    );

    // 6. Measure again: +12 semitones is one octave, so ~880 Hz. Allow a wide
    // tolerance — the pitch backend is not a perfect resampler, but an octave is
    // unmistakable versus the 440 Hz baseline.
    const shiftedHz = await measureRenderedPitch(track.id);
    expect(shiftedHz).toBeGreaterThan(700);
    expect(shiftedHz).toBeLessThan(1050);

    // Reset transpose AND solo so later flows start from a neutral session.
    // Re-resolve the index: transposing resized the region, which can reorder
    // `song.regions`.
    const regionsAfter = (await AppPage.songView())?.regions ?? [];
    const resetIndex = regionsAfter.findIndex((r) => r.id === regionId);
    await setRegionTranspose(0, resetIndex >= 0 ? resetIndex : 0);
    await toggleTrackSolo(track.id);
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find((t) => t.id === track.id)
          ?.solo === false,
      { timeout: 30_000, timeoutMsg: "Solo never cleared after transpose" },
    );
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
