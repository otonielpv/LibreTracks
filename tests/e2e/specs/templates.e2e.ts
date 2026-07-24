import { browser, expect } from "@wdio/globals";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { writeToneWav } from "./session/support.js";

/**
 * Session template round-trip, in its own clean session.
 *
 * A `.lttemplate` is a session stripped to structure + routing only:
 * strip_song_to_template (state/mod.rs) keeps the tracks (and folder
 * hierarchy) but drops all clips/regions/markers and resets the mix. This spec
 * builds a session with known named tracks, saves it as a template, then
 * creates a NEW session from that template and asserts the tracks survive
 * (by name) while no clips carry over.
 *
 * The native save/open dialogs (rfd) can't be piloted by WebDriver, so the
 * flow uses two dialog-free seam commands: `saveSessionAsTemplateAt(path)`
 * (a test-only backend command mirroring the dialog save) and
 * `createSessionFromTemplate(templatePath, name, parentDir)` (the production
 * start_create_song_from_template_named_at, which already accepts an explicit
 * folder for the Android/no-dialog path).
 */
describe("Session templates (isolated session)", () => {
  let workDir = "";
  let templatePath = "";
  let audioFilePath = "";
  const TRACK_ONE = "E2E Template Track One";
  const TRACK_TWO = "E2E Template Track Two";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();

    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-template-"));
    templatePath = path
      .join(workDir, "e2e-structure.lttemplate")
      .replace(/\\/g, "/");
    audioFilePath = path.join(workDir, "e2e-tone.wav");
    writeToneWav(audioFilePath);

    await AppPage.createSession("E2E Template Source", workDir);
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
        { timeoutMsg: "Engine did not stop before template teardown" },
      );
    }
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("saves a session as a template and creates a new session from it", async () => {
    // Build a known two-track structure in the source session. The clips these
    // create don't matter — a template drops all clips — but they give each
    // track a name we can assert survives the round trip. Placed far apart so
    // each lands in its own region.
    await AppPage.createAudioTracksWithClips([
      { trackName: TRACK_ONE, filePath: audioFilePath, timelineStartSeconds: 20 },
      { trackName: TRACK_TWO, filePath: audioFilePath, timelineStartSeconds: 60 },
    ]);
    await browser.waitUntil(
      async () => {
        const tracks = (await AppPage.songView())?.tracks ?? [];
        return (
          tracks.some((t) => t.name === TRACK_ONE) &&
          tracks.some((t) => t.name === TRACK_TWO)
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "The template's source tracks never reached the model",
      },
    );
    // The source session does have clips (which the template must NOT carry).
    expect((await AppPage.songView())?.clips.length ?? 0).toBeGreaterThan(0);

    // Save it as a template at an explicit path (no native dialog). We save to
    // our own temp dir, so we drive creation by that explicit path rather than
    // the default-folder listing (landing.e2e.ts covers the landing list).
    await AppPage.saveSessionAsTemplateAt(templatePath);
    expect(existsSync(templatePath.replace(/\//g, path.sep))).toBe(true);

    const sourceSessionPath = (await AppPage.transportSnapshot()).songFilePath;

    // Create a brand-new session from the template, in a fresh child folder.
    // The backend requires the parent folder to exist already (it does not
    // mkdir the destination), so create it first — same as mkdtemp does for the
    // source session's parent.
    const childDir = path.join(workDir, "from-template");
    mkdirSync(childDir, { recursive: true });
    await AppPage.createSessionFromTemplate(
      templatePath,
      "E2E From Template",
      childDir,
    );

    // It's a genuinely NEW session: a different .ltsession file, under the
    // child folder we named.
    await browser.waitUntil(
      async () => {
        const p = (await AppPage.transportSnapshot()).songFilePath ?? "";
        return p !== sourceSessionPath && p.includes("E2E From Template");
      },
      {
        timeout: 60_000,
        timeoutMsg: "The template-created session did not open as a new project",
      },
    );

    // The new session carries the template's tracks by name...
    await browser.waitUntil(
      async () => {
        const song = await AppPage.songView();
        return (
          (song?.tracks.some((t) => t.name === TRACK_ONE) ?? false) &&
          (song?.tracks.some((t) => t.name === TRACK_TWO) ?? false)
        );
      },
      {
        timeout: 60_000,
        timeoutMsg:
          "The new session did not carry the template's tracks by name",
      },
    );

    const created = await AppPage.songView();
    // ...with the structure but none of the source content (templates drop all
    // clips — strip_song_to_template).
    expect(created?.clips.length ?? -1).toBe(0);
    // Exactly the two named tracks survived the round trip.
    expect(created?.tracks.filter((t) => t.name === TRACK_ONE).length).toBe(1);
    expect(created?.tracks.filter((t) => t.name === TRACK_TWO).length).toBe(1);
  });
});
