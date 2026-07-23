import { expect } from "@wdio/globals";
import { existsSync } from "node:fs";
import AppPage from "../../pageobjects/app.page.js";
import type { SessionFixture } from "./support.js";

export function registerSessionSetupFlows(fixture: SessionFixture) {
  it("leaves the landing and mounts the timeline shell", async () => {
    await expect(await AppPage.timelineShell).toBeDisplayed();
    await expect(await AppPage.emptyStateCardMaybe).not.toBeExisting();
  });

  it("enables the transport controls once a session is open", async () => {
    const play = await AppPage.playButton;
    if (await play.isExisting()) {
      await expect(play).toBeEnabled();
    }

    const metronome = await AppPage.metronomeButton;
    if (await metronome.isExisting()) {
      await expect(metronome).toBeEnabled();
    }
  });

  it("writes the session to the chosen folder", async () => {
    await expect(await AppPage.timelineShell).toBeDisplayed();
    expect(existsSync(fixture.sessionParentDir)).toBe(true);
  });
}
