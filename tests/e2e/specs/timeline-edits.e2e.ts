import { browser } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { registerSessionTimelineEditFlows } from "./session/timelineEdits.flows.js";
import {
  AUDIO_FILE_NAME,
  UNUSED_AUDIO_FILE_NAME,
  type SessionFixture,
  writeToneWav,
} from "./session/support.js";

/**
 * Timeline edit-operation edge cases run against their OWN clean session.
 *
 * These cases (moving clips, resizing/moving/splitting regions, the
 * "regions can't cross" invariant, clip-window trimming, marker edits) assert
 * against an exact region/clip topology they build themselves. Running them in
 * the shared `session.e2e.ts` project made them brittle: the ~25 flows before
 * them leave the song with an unpredictable multi-region layout (a single
 * region can end up spanning tens of seconds), so a fixed clip placement could
 * land inside a pre-existing region and a move could straddle a boundary that
 * wasn't there in a previous run.
 *
 * A separate spec file relaunches the app fresh (new WebDriver session, new
 * native window), so this project starts with a pristine, single-region song
 * that the flow fully controls. The flow itself still builds and tears down its
 * own disposable tracks/clips/regions; here it simply does so with no prior
 * flows having mutated the topology.
 */
describe("Timeline edits (isolated session)", () => {
  const fixture: SessionFixture = {
    sessionParentDir: "",
    audioFilePath: "",
    unusedAudioFilePath: "",
    sessionFilePath: "",
    initialMetronomeEnabled: null,
  };

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();

    fixture.sessionParentDir = mkdtempSync(
      path.join(tmpdir(), "lt-e2e-edits-"),
    );
    fixture.audioFilePath = path.join(fixture.sessionParentDir, AUDIO_FILE_NAME);
    fixture.unusedAudioFilePath = path.join(
      fixture.sessionParentDir,
      UNUSED_AUDIO_FILE_NAME,
    );
    writeToneWav(fixture.audioFilePath);
    writeToneWav(fixture.unusedAudioFilePath, 1);

    await AppPage.createSession("E2E Edits Session", fixture.sessionParentDir);
    const createdSessionPath = (await AppPage.transportSnapshot()).songFilePath;
    if (!createdSessionPath) {
      throw new Error("The engine did not report the created session path");
    }
    fixture.sessionFilePath = createdSessionPath;
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.transportSnapshot()).playbackState === "stopped",
        { timeoutMsg: "Engine did not stop before edits-session teardown" },
      );
    }
    if (fixture.sessionParentDir && existsSync(fixture.sessionParentDir)) {
      rmSync(fixture.sessionParentDir, { recursive: true, force: true });
    }
  });

  registerSessionTimelineEditFlows(fixture);
});
