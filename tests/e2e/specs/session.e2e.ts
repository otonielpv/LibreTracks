import { browser } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { registerSessionAudioFlows } from "./session/audio.flows.js";
import { registerSessionEditingFlows } from "./session/editing.flows.js";
import { registerSessionLibraryFlows } from "./session/library.flows.js";
import { registerSessionMixFlows } from "./session/mix.flows.js";
import { registerSessionNavigationFlows } from "./session/navigation.flows.js";
import { registerSessionPersistenceFlows } from "./session/persistence.flows.js";
import { registerSessionRegionFlows } from "./session/regions.flows.js";
import { registerSessionSetupFlows } from "./session/setup.flows.js";
import {
  AUDIO_FILE_NAME,
  UNUSED_AUDIO_FILE_NAME,
  type SessionFixture,
  writeToneWav,
} from "./session/support.js";
import { registerSessionTransportFlows } from "./session/transport.flows.js";

/**
 * Open-session flows share one native project because each block builds on the
 * canonical state produced by the previous one. Keep this file as the lifecycle
 * and ordering manifest; domain-specific tests live in ./session/*.flows.ts.
 */
describe("Session creation", () => {
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
      path.join(tmpdir(), "lt-e2e-session-"),
    );
    fixture.audioFilePath = path.join(
      fixture.sessionParentDir,
      AUDIO_FILE_NAME,
    );
    fixture.unusedAudioFilePath = path.join(
      fixture.sessionParentDir,
      UNUSED_AUDIO_FILE_NAME,
    );
    writeToneWav(fixture.audioFilePath);
    writeToneWav(fixture.unusedAudioFilePath, 1);

    await AppPage.createSession("E2E Session", fixture.sessionParentDir);
    const createdSessionPath = (await AppPage.transportSnapshot()).songFilePath;
    if (!createdSessionPath) {
      throw new Error("The engine did not report the created session path");
    }
    fixture.sessionFilePath = createdSessionPath;
    fixture.initialMetronomeEnabled = (
      await AppPage.settings()
    ).metronomeEnabled;
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
    }
    if (
      fixture.initialMetronomeEnabled !== null &&
      (await AppPage.settings()).metronomeEnabled !==
        fixture.initialMetronomeEnabled
    ) {
      await (await AppPage.metronomeButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.settings()).metronomeEnabled ===
          fixture.initialMetronomeEnabled,
      );
    }

    if (
      fixture.sessionParentDir &&
      existsSync(fixture.sessionParentDir)
    ) {
      rmSync(fixture.sessionParentDir, { recursive: true, force: true });
    }
  });

  registerSessionSetupFlows(fixture);
  registerSessionAudioFlows(fixture);
  registerSessionPersistenceFlows(fixture);
  registerSessionEditingFlows();
  registerSessionLibraryFlows();
  registerSessionNavigationFlows();
  registerSessionMixFlows(fixture);
  registerSessionTransportFlows(fixture);
  registerSessionRegionFlows();
});
