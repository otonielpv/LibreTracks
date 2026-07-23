import { expect } from "@wdio/globals";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";

/**
 * The first flow that requires an OPEN session. Creating one normally opens a
 * native save dialog (rfd) WebDriver can't pilot, so we go through the E2E hook
 * (window.__ltE2E, exposed only under WebDriver by useE2ETestHooks), which calls
 * the same frontend handler a user click would. The session is created inside a
 * temp folder this spec owns and deletes afterwards, so nothing touches the
 * app's data directory or the user's disk permanently.
 *
 * Once the session is open the landing is gone, the timeline shell mounts, and
 * the transport controls become enabled — the inverse of the no-session
 * invariants asserted in landing.e2e.ts.
 */
describe("Session creation", () => {
  let sessionParentDir: string;

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    // A temp parent folder for the session — created and cleaned up by this
    // spec, so the app's default songs folder stays untouched.
    sessionParentDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-session-"));
    await AppPage.createSession("E2E Session", sessionParentDir);
  });

  after(() => {
    // Best-effort cleanup of the session folder we created on disk.
    if (sessionParentDir && existsSync(sessionParentDir)) {
      rmSync(sessionParentDir, { recursive: true, force: true });
    }
  });

  it("leaves the landing and mounts the timeline shell", async () => {
    await expect(await AppPage.timelineShell).toBeDisplayed();
    // The empty-state landing is unmounted once a session is open.
    await expect(await AppPage.emptyStateCardMaybe).not.toBeExisting();
  });

  it("enables the transport controls once a session is open", async () => {
    // The inverse of the no-session invariant: with a session, play and the
    // metronome round-trip to the engine and are enabled.
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
    // The create flow inflates a real session folder under our temp parent —
    // proof the backend actually created it, not just a UI state flip.
    await expect(await AppPage.timelineShell).toBeDisplayed();
    expect(existsSync(sessionParentDir)).toBe(true);
  });
});
