import { browser } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { registerSessionTempoFlows } from "./session/tempo.flows.js";

/**
 * Song tempo + time-signature edge cases, run against their own clean session.
 *
 * A separate spec relaunches the app fresh, so the song starts at the default
 * 120 BPM / 4/4 with no warp — the view→source time mapping the upsert commands
 * use is the identity, so positional markers land exactly where asked and the
 * assertions stay deterministic. No audio is needed (tempo/time-signature are
 * pure song metadata), so the session has no imported clips.
 */
describe("Tempo & time signature (isolated session)", () => {
  let sessionParentDir = "";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();

    sessionParentDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-tempo-"));
    await AppPage.createSession("E2E Tempo Session", sessionParentDir);
    const createdSessionPath = (await AppPage.transportSnapshot()).songFilePath;
    if (!createdSessionPath) {
      throw new Error("The engine did not report the created session path");
    }
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.transportSnapshot()).playbackState === "stopped",
        { timeoutMsg: "Engine did not stop before tempo-session teardown" },
      );
    }
    if (sessionParentDir && existsSync(sessionParentDir)) {
      rmSync(sessionParentDir, { recursive: true, force: true });
    }
  });

  registerSessionTempoFlows();
});
