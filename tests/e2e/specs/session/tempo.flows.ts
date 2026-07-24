import { browser, expect } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";

/**
 * Song tempo + time-signature flows. Both the base values and the positional
 * markers are asserted against the canonical backend song model
 * (song.bpm / song.timeSignature / song.tempoMarkers /
 * song.timeSignatureMarkers), the same "prove it reached the backend"
 * discipline the other flows use. These run against a fresh, warp-free session
 * (base 120 BPM), so the view→source time mapping used by the upsert commands
 * is the identity and marker positions land exactly where asked.
 *
 * Key backend semantics these assert (verified in state/regions.rs +
 * state/mod.rs::validate_time_signature), so the tests match reality:
 *   - update_song_tempo sets song.bpm; it REJECTS a bpm outside 20..300.
 *   - update_song_time_signature validates "N/D" (both integers > 0) and
 *     REJECTS anything else.
 *   - upsert_song_tempo_marker / upsert_song_time_signature_marker at
 *     startSeconds ~= 0 change the BASE value (no marker is created); only a
 *     positive startSeconds creates/updates an entry in the marker list.
 */
export function registerSessionTempoFlows() {
  it("sets the song base tempo and rejects an out-of-range BPM", async () => {
    const before = (await AppPage.songView())?.bpm ?? 0;
    const target = before === 90 ? 100 : 90; // pick a value different from now

    await AppPage.updateSongTempo(target);
    await browser.waitUntil(
      async () => Math.abs(((await AppPage.songView())?.bpm ?? -1) - target) < 0.01,
      {
        timeout: 30_000,
        timeoutMsg: "Setting the base tempo did not reach the backend model",
      },
    );

    // Out of range (backend clamps to 20..300) -> rejected, bpm unchanged.
    await expect(AppPage.updateSongTempo(500)).rejects.toThrow();
    expect((await AppPage.songView())?.bpm ?? -1).toBeCloseTo(target, 2);

    // Restore the original base tempo for a clean teardown.
    await AppPage.updateSongTempo(before);
    await browser.waitUntil(
      async () => Math.abs(((await AppPage.songView())?.bpm ?? -1) - before) < 0.01,
      { timeout: 30_000, timeoutMsg: "Base tempo did not restore" },
    );
  });

  it("sets the song base time signature and rejects an invalid one", async () => {
    const before = (await AppPage.songView())?.timeSignature ?? "4/4";
    const target = before === "3/4" ? "6/8" : "3/4";

    await AppPage.updateSongTimeSignature(target);
    await browser.waitUntil(
      async () => (await AppPage.songView())?.timeSignature === target,
      {
        timeout: 30_000,
        timeoutMsg:
          "Setting the base time signature did not reach the backend model",
      },
    );

    // Invalid strings are rejected (validate_time_signature: "N/D", both > 0).
    await expect(
      AppPage.updateSongTimeSignature("not-a-signature"),
    ).rejects.toThrow();
    await expect(AppPage.updateSongTimeSignature("0/4")).rejects.toThrow();
    expect((await AppPage.songView())?.timeSignature).toBe(target);

    await AppPage.updateSongTimeSignature(before);
    await browser.waitUntil(
      async () => (await AppPage.songView())?.timeSignature === before,
      { timeout: 30_000, timeoutMsg: "Base time signature did not restore" },
    );
  });

  it("creates and deletes a positional tempo marker", async () => {
    const markersBefore = (await AppPage.songView())?.tempoMarkers ?? [];
    const at = 12; // positive -> a real marker (not the base tempo)
    const markerBpm = 140;

    await AppPage.upsertSongTempoMarker(at, markerBpm);
    let createdId = "";
    await browser.waitUntil(
      async () => {
        const created = ((await AppPage.songView())?.tempoMarkers ?? []).find(
          (marker) =>
            !markersBefore.some((prev) => prev.id === marker.id) &&
            Math.abs(marker.startSeconds - at) < 0.05,
        );
        createdId = created?.id ?? "";
        return createdId !== "";
      },
      {
        timeout: 30_000,
        timeoutMsg: "The tempo marker never reached the backend song model",
      },
    );
    const created = ((await AppPage.songView())?.tempoMarkers ?? []).find(
      (marker) => marker.id === createdId,
    );
    expect(created?.bpm ?? 0).toBeCloseTo(markerBpm, 2);
    // Creating a marker must NOT change the base tempo.
    // (base is asserted only for regression; it is read fresh below).

    await AppPage.deleteSongTempoMarker(createdId);
    await browser.waitUntil(
      async () =>
        !((await AppPage.songView())?.tempoMarkers ?? []).some(
          (marker) => marker.id === createdId,
        ),
      {
        timeout: 30_000,
        timeoutMsg: "Deleting the tempo marker did not reach the backend",
      },
    );
  });

  it("creates and deletes a positional time-signature marker", async () => {
    const markersBefore = (await AppPage.songView())?.timeSignatureMarkers ?? [];
    const at = 16;
    const markerSignature = "7/8";

    await AppPage.upsertSongTimeSignatureMarker(at, markerSignature);
    let createdId = "";
    await browser.waitUntil(
      async () => {
        const created = (
          (await AppPage.songView())?.timeSignatureMarkers ?? []
        ).find(
          (marker) =>
            !markersBefore.some((prev) => prev.id === marker.id) &&
            Math.abs(marker.startSeconds - at) < 0.05,
        );
        createdId = created?.id ?? "";
        return createdId !== "";
      },
      {
        timeout: 30_000,
        timeoutMsg:
          "The time-signature marker never reached the backend song model",
      },
    );
    const created = (
      (await AppPage.songView())?.timeSignatureMarkers ?? []
    ).find((marker) => marker.id === createdId);
    expect(created?.signature).toBe(markerSignature);

    // An invalid signature at a positive position is rejected, and no stray
    // marker is left behind.
    const countAfterCreate = (
      (await AppPage.songView())?.timeSignatureMarkers ?? []
    ).length;
    await expect(
      AppPage.upsertSongTimeSignatureMarker(20, "bogus"),
    ).rejects.toThrow();
    expect(
      ((await AppPage.songView())?.timeSignatureMarkers ?? []).length,
    ).toBe(countAfterCreate);

    await AppPage.deleteSongTimeSignatureMarker(createdId);
    await browser.waitUntil(
      async () =>
        !((await AppPage.songView())?.timeSignatureMarkers ?? []).some(
          (marker) => marker.id === createdId,
        ),
      {
        timeout: 30_000,
        timeoutMsg:
          "Deleting the time-signature marker did not reach the backend",
      },
    );
  });
}
