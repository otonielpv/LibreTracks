import { browser, expect } from "@wdio/globals";
import { existsSync, readFileSync } from "node:fs";
import AppPage from "../../pageobjects/app.page.js";
import type { SessionFixture } from "./support.js";

export function registerSessionPersistenceFlows(fixture: SessionFixture) {
  it("persists track and clip edits when switching away and reopening", async () => {
    const originalSong = await AppPage.songView();
    const track = originalSong?.tracks.find(
      (candidate) => candidate.name === "E2E Audio Track",
    );
    if (!originalSong || !track) {
      throw new Error("Original E2E session is missing its audio track");
    }
    expect(track.muted).toBe(true);
    expect(originalSong.clips).toHaveLength(1);

    await browser.keys(["Control", "s"]);
    await browser.waitUntil(
      async () => {
        if (!existsSync(fixture.sessionFilePath)) {
          return false;
        }
        const persisted = JSON.parse(
          readFileSync(fixture.sessionFilePath, "utf8"),
        ) as {
          tracks?: Array<{ id: string; muted: boolean }>;
          clips?: Array<{ trackId: string }>;
        };
        return (
          persisted.tracks?.some(
            (candidate) => candidate.id === track.id && candidate.muted,
          ) === true &&
          persisted.clips?.some(
            (candidate) => candidate.trackId === track.id,
          ) === true
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "Ctrl+S did not persist the track and clip edits",
      },
    );

    await AppPage.createSession("E2E Scratch", fixture.sessionParentDir);
    await browser.waitUntil(
      async () => {
        const song = await AppPage.songView();
        return song !== null && song.id !== originalSong.id;
      },
      {
        timeout: 60_000,
        timeoutMsg: "The scratch session never replaced the original session",
      },
    );
    expect((await AppPage.songView())?.tracks.length).toBe(0);

    await AppPage.openSession(fixture.sessionFilePath, originalSong.id);
    const reopenedSong = await AppPage.songView();
    const reopenedTrack = reopenedSong?.tracks.find(
      (candidate) => candidate.id === track.id,
    );
    expect(reopenedTrack?.name).toBe("E2E Audio Track");
    expect(reopenedTrack?.muted).toBe(true);
    expect(reopenedSong?.clips).toHaveLength(1);
    expect(reopenedSong?.clips[0]?.trackId).toBe(track.id);
  });
}
