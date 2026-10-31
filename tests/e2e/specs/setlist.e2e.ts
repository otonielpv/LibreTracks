import { $, $$, browser, expect } from "@wdio/globals";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { removeWorkDir } from "../utils/workdir.js";

/**
 * Setlist view smoke test (plan setlist-view, paso 19): the view mounts in
 * the REAL WebView over a session, shows the song row, the section map and
 * the mixer, and a section jump scheduled from the keyboard (Playback's
 * "Live ReOrder": → moves the cursor, Enter jumps) reaches the engine.
 *
 * Its own session, like charts.e2e.ts, so it runs anywhere (CI included)
 * instead of depending on the docs-shots session of one machine. It asserts
 * the jump through the transport snapshot, not through audio: it does not
 * try to prove timing or lock behaviour.
 */
type JumpSnapshot = {
  playbackState: string;
  positionSeconds: number;
  pendingMarkerJump?: { targetMarkerId: string } | null;
};

const VERSE_SECONDS = 8;
const CHORUS_SECONDS = 20;

describe("Setlist view", () => {
  let workDir = "";
  let verseId = "";
  let chorusId = "";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-setlist-"));
    await AppPage.createSession("E2E Setlist Session", workDir);

    await AppPage.createSongRegion(0, 40);
    await browser.waitUntil(async () => ((await AppPage.songView())?.regions.length ?? 0) === 1, {
      timeoutMsg: "The song was not created",
    });
    verseId = await AppPage.createSectionMarker(VERSE_SECONDS);
    chorusId = await AppPage.createSectionMarker(CHORUS_SECONDS);
    await AppPage.setSectionMarkerKind(verseId, "verse", null);
    await AppPage.setSectionMarkerKind(chorusId, "chorus", null);
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () => (await AppPage.transportSnapshot()).playbackState === "stopped",
        { timeoutMsg: "Engine did not stop before the Setlist teardown" },
      );
    }
    await browser.execute(() => (window as any).__ltE2E.setViewMode("daw"));
    removeWorkDir(workDir);
  });

  it("shows the song row, the section map and the mixer", async () => {
    await browser.execute(() => (window as any).__ltE2E.setViewMode("setlist"));
    await (await $(".lt-setlist-view")).waitForDisplayed({ timeout: 15_000 });

    await browser.waitUntil(async () => (await $$(".lt-setlist-song-tile").length) === 1, {
      timeoutMsg: "The song row did not show the song",
    });
    // The implicit start plus the two sections.
    await browser.waitUntil(async () => (await $$(".lt-setlist-map-block").length) === 3, {
      timeoutMsg: "The section map did not show the song's sections",
    });
    await expect($(`.lt-setlist-map-block[data-block-id="${chorusId}"]`)).toBeDisplayed();
    await expect($(".lt-setlist-mixer")).toBeDisplayed();
  });

  it("plays and jumps to a section from the keyboard", async () => {
    await (await AppPage.playButton).click();
    await browser.waitUntil(
      async () => (await AppPage.transportSnapshot()).playbackState === "playing",
      { timeout: 15_000, timeoutMsg: "Playback did not start" },
    );
    // The click left the focus on the play button; the keys go to the view.
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());

    // From the implicit start: → Verse, → Chorus.
    await browser.keys(["ArrowRight"]);
    await browser.keys(["ArrowRight"]);
    await expect($(`.lt-setlist-map-block.is-cursor[data-block-id="${chorusId}"]`)).toBeDisplayed();

    await browser.keys(["Enter"]);
    await browser.waitUntil(
      async () => {
        const snapshot = (await AppPage.transportSnapshot()) as unknown as JumpSnapshot;
        // Scheduled for later (the jump mode waits) or already done.
        return (
          snapshot.pendingMarkerJump?.targetMarkerId === chorusId ||
          snapshot.positionSeconds >= CHORUS_SECONDS
        );
      },
      { timeout: 15_000, timeoutMsg: "The keyboard jump to the chorus never reached the engine" },
    );
    await expect($(".lt-setlist-map-block.is-cursor")).not.toBeExisting();
  });
});
