import { browser, expect, $ } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage, {
  type E2ESongView,
} from "../pageobjects/app.page.js";

const AUDIO_FILE_NAME = "e2e-tone.wav";
const UNUSED_AUDIO_FILE_NAME = "e2e-unused.wav";

/** Write a small PCM WAV fixture that the real native decoder can import. */
function writeToneWav(filePath: string, durationSeconds = 5) {
  const sampleRate = 44_100;
  const sampleCount = sampleRate * durationSeconds;
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(
      Math.sin((index * 2 * Math.PI * 440) / sampleRate) * 4_000,
    );
    wav.writeInt16LE(sample, 44 + index * 2);
  }
  writeFileSync(filePath, wav);
}

/** Open the context menu at a clip's rendered position after timeline fitting. */
async function openClipContextMenu(
  clip: E2ESongView["clips"][number],
) {
  await browser.execute(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const lane = await AppPage.trackLane(clip.trackId);
  const laneSize = await lane.getSize();
  const timelineView = await AppPage.timelineView();
  const pixelsPerSecond = timelineView.zoomLevel * 18;
  const clipCenterFromLeft =
    clip.timelineStartSeconds * pixelsPerSecond -
    timelineView.cameraX +
    Math.min(clip.durationSeconds * pixelsPerSecond / 2, 12);
  await lane.click({
    button: "right",
    x: Math.round(clipCenterFromLeft - laneSize.width / 2),
    y: 0,
  });
  const menu = await $(".lt-context-menu");
  await menu.waitForDisplayed();
  return menu;
}

/** Send a real W3C Ctrl+wheel gesture while keeping both input sources aligned. */
async function zoomTimelineWithWheel(
  origin: ReturnType<typeof $>,
  deltaY: number,
) {
  const keyboard = browser
    .action("key")
    .down(Key.Ctrl)
    .pause(100)
    .up(Key.Ctrl);
  const wheel = browser
    .action("wheel")
    .pause(20)
    .scroll({ origin, deltaX: 0, deltaY, duration: 50 })
    .pause(30);
  await browser.actions([keyboard, wheel]);
}

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
  let audioFilePath: string;
  let unusedAudioFilePath: string;
  let sessionFilePath: string;
  let initialMetronomeEnabled: boolean | null = null;

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    // A temp parent folder for the session — created and cleaned up by this
    // spec, so the app's default songs folder stays untouched.
    sessionParentDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-session-"));
    audioFilePath = path.join(sessionParentDir, AUDIO_FILE_NAME);
    unusedAudioFilePath = path.join(sessionParentDir, UNUSED_AUDIO_FILE_NAME);
    writeToneWav(audioFilePath);
    writeToneWav(unusedAudioFilePath, 1);
    await AppPage.createSession("E2E Session", sessionParentDir);
    const createdSessionPath = (await AppPage.transportSnapshot()).songFilePath;
    if (!createdSessionPath) {
      throw new Error("The engine did not report the created session path");
    }
    sessionFilePath = createdSessionPath;
    initialMetronomeEnabled = (await AppPage.settings()).metronomeEnabled;
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
    }
    if (
      initialMetronomeEnabled !== null &&
      (await AppPage.settings()).metronomeEnabled !== initialMetronomeEnabled
    ) {
      await (await AppPage.metronomeButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.settings()).metronomeEnabled ===
          initialMetronomeEnabled,
      );
    }

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

  it("adds an audio track through the timeline context menu", async () => {
    const headers = await AppPage.trackHeadersPane;
    await headers.click({ button: "right", x: 0, y: 50 });

    const menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    const addTrack = await menu.$("button=Añadir track de audio");
    await addTrack.waitForClickable();
    await addTrack.click();

    const input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Audio Track");
    await $(".lt-dialog-button--primary").click();

    await browser.waitUntil(async () => {
      const song = await AppPage.songView();
      return song?.tracks.some((track) => track.name === "E2E Audio Track");
    }, {
      timeout: 30_000,
      timeoutMsg: "The created track never reached the backend song model",
    });

    const header = await $(".lt-track-header*=E2E Audio Track");
    await expect(header).toBeDisplayed();
  });

  it("imports audio into the enabled library without adding a clip", async () => {
    await AppPage.openLibrary();
    await expect(await AppPage.libraryImportButton).toBeEnabled();

    const clipsBefore = (await AppPage.songView())?.clips.length ?? 0;
    await AppPage.importLibraryAudio([audioFilePath, unusedAudioFilePath]);

    const asset = await AppPage.libraryAsset(AUDIO_FILE_NAME);
    await asset.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: "Imported audio never appeared in the library",
    });
    await (
      await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME)
    ).waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: "Unused imported audio never appeared in the library",
    });
    expect((await AppPage.songView())?.clips.length ?? 0).toBe(clipsBefore);
  });

  it("places library audio on the timeline and deletes the clip", async () => {
    const songBefore = await AppPage.songView();
    const track = songBefore?.tracks.find(
      (candidate) => candidate.name === "E2E Audio Track",
    );
    if (!track) {
      throw new Error("E2E Audio Track is missing before the timeline flow");
    }

    const asset = await AppPage.libraryAsset(AUDIO_FILE_NAME);
    const lane = await AppPage.trackLane(track.id);
    await asset.dragAndDrop(lane);

    await browser.waitUntil(async () => {
      const song = await AppPage.songView();
      return (song?.clips.length ?? 0) === 1;
    }, {
      timeout: 60_000,
      timeoutMsg: "Dragging the library asset did not create a timeline clip",
    });

    // The first clip triggers fit-to-window, so resolve its rendered position
    // from the same public camera/zoom values used by timeline hit testing.
    const songWithClip = await AppPage.songView();
    const clip = songWithClip?.clips[0];
    if (!songWithClip || !clip) {
      throw new Error("Timeline clip disappeared before duplication");
    }
    const clipMenu = await openClipContextMenu(clip);
    expect(await clipMenu.getText()).toContain("Borrar");
    // The button text also includes the rendered "Del" shortcut, so use a
    // contains-text selector rather than the exact `button=Borrar` form.
    const deleteButton = await clipMenu.$("button*=Borrar");
    await deleteButton.waitForClickable();
    await deleteButton.click();

    await browser.waitUntil(async () => {
      const song = await AppPage.songView();
      return (song?.clips.length ?? 0) === 0;
    }, {
      timeout: 30_000,
      timeoutMsg: "Deleting the clip did not update the backend song model",
    });
  });

  it("mutes the real post-mix track signal in the native engine", async () => {
    const songBefore = await AppPage.songView();
    const track = songBefore?.tracks.find(
      (candidate) => candidate.name === "E2E Audio Track",
    );
    if (!track) {
      throw new Error("E2E Audio Track is missing before the audio-meter flow");
    }

    const asset = await AppPage.libraryAsset(AUDIO_FILE_NAME);
    const lane = await AppPage.trackLane(track.id);
    await asset.dragAndDrop(lane);
    await browser.waitUntil(
      async () => (await AppPage.songView())?.clips.length === 1,
      {
        timeout: 60_000,
        timeoutMsg: "The persisted clip was never created",
      },
    );

    const songWithClip = await AppPage.songView();
    const clip = songWithClip?.clips[0];
    if (!clip) {
      throw new Error("The audio clip disappeared before playback");
    }

    const timelineView = await AppPage.timelineView();
    const ruler = await AppPage.timelineRuler;
    const rulerSize = await ruler.getSize();
    const pixelsPerSecond = timelineView.zoomLevel * 18;
    const seekSeconds =
      clip.timelineStartSeconds + Math.min(clip.durationSeconds / 2, 0.5);
    const seekFromLeft =
      seekSeconds * pixelsPerSecond - timelineView.cameraX;
    await ruler.click({
      x: Math.round(seekFromLeft - rulerSize.width / 2),
      y: 0,
    });
    await browser.waitUntil(
      async () =>
        Math.abs(
          (await AppPage.transportSnapshot()).positionSeconds - seekSeconds,
        ) < 0.2,
      {
        timeout: 30_000,
        timeoutMsg: "Timeline seek did not reach the imported audio clip",
      },
    );

    await (await AppPage.playButton).click();
    await AppPage.waitForTrackSignal(track.id);

    const trackHeader = await $(
      `.lt-track-header-row[data-track-id="${track.id}"]`,
    );
    const muteButton = await trackHeader.$("button=M");
    await muteButton.waitForClickable();
    await muteButton.click();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === track.id,
        )?.muted === true,
      {
        timeout: 30_000,
        timeoutMsg: "The mute edit never reached the backend song model",
      },
    );

    await AppPage.waitForTrackSilence(track.id);

    await (await AppPage.stopButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "stopped",
      { timeoutMsg: "The engine did not stop after the audio-meter flow" },
    );
  });

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
        if (!existsSync(sessionFilePath)) {
          return false;
        }
        const persisted = JSON.parse(readFileSync(sessionFilePath, "utf8")) as {
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

    await AppPage.createSession("E2E Scratch", sessionParentDir);
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

    await AppPage.openSession(sessionFilePath, originalSong.id);
    const reopenedSong = await AppPage.songView();
    const reopenedTrack = reopenedSong?.tracks.find(
      (candidate) => candidate.id === track.id,
    );
    expect(reopenedTrack?.name).toBe("E2E Audio Track");
    expect(reopenedTrack?.muted).toBe(true);
    expect(reopenedSong?.clips).toHaveLength(1);
    expect(reopenedSong?.clips[0]?.trackId).toBe(track.id);
  });

  it("renames and deletes an empty track through its context menu", async () => {
    const songBefore = await AppPage.songView();
    const anchorTrack = songBefore?.tracks.find(
      (candidate) => candidate.name === "E2E Audio Track",
    );
    if (!anchorTrack) {
      throw new Error("The anchor track is missing before track editing");
    }

    const anchorHeader = await $(
      `.lt-track-header-row[data-track-id="${anchorTrack.id}"] .lt-track-header`,
    );
    await anchorHeader.click({ button: "right" });
    let menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Insertar track")).click();

    let input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Disposable");
    await (await $(".lt-dialog-button--primary")).click();

    let disposableId = "";
    await browser.waitUntil(
      async () => {
        const track = (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.name === "E2E Disposable",
        );
        disposableId = track?.id ?? "";
        return disposableId !== "";
      },
      {
        timeout: 30_000,
        timeoutMsg: "The disposable track was never created",
      },
    );

    const disposableHeader = await $(
      `.lt-track-header-row[data-track-id="${disposableId}"] .lt-track-header`,
    );
    await disposableHeader.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button*=Renombrar")).click();

    input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Renamed Track");
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.some(
          (candidate) =>
            candidate.id === disposableId &&
            candidate.name === "E2E Renamed Track",
        ) === true,
      {
        timeout: 30_000,
        timeoutMsg: "Renaming the track did not reach the backend model",
      },
    );

    await disposableHeader.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Borrar")).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.some(
          (candidate) => candidate.id === disposableId,
        ) === false,
      {
        timeout: 30_000,
        timeoutMsg: "Deleting the empty track did not reach the backend model",
      },
    );
  });

  it("splits and duplicates a clip through timeline editing", async () => {
    const songBefore = await AppPage.songView();
    const originalClip = songBefore?.clips[0];
    if (!originalClip || songBefore.clips.length !== 1) {
      throw new Error("Expected one persisted clip before timeline editing");
    }

    const splitSeconds =
      originalClip.timelineStartSeconds + originalClip.durationSeconds / 2;
    const timelineView = await AppPage.timelineView();
    const ruler = await AppPage.timelineRuler;
    const rulerSize = await ruler.getSize();
    const splitFromLeft =
      splitSeconds * timelineView.zoomLevel * 18 - timelineView.cameraX;
    await ruler.click({
      x: Math.round(splitFromLeft - rulerSize.width / 2),
      y: 0,
    });
    await browser.waitUntil(
      async () =>
        Math.abs(
          (await AppPage.transportSnapshot()).positionSeconds - splitSeconds,
        ) < 0.2,
      {
        timeout: 30_000,
        timeoutMsg: "The playhead did not reach the clip split point",
      },
    );

    let menu = await openClipContextMenu(originalClip);
    const splitButton = await menu.$("button*=Cortar en cursor");
    await splitButton.waitForClickable();
    await splitButton.click();
    await browser.waitUntil(
      async () => (await AppPage.songView())?.clips.length === 2,
      {
        timeout: 30_000,
        timeoutMsg: "Splitting the clip did not create two backend clips",
      },
    );

    const splitClips = [...((await AppPage.songView())?.clips ?? [])].sort(
      (left, right) => left.timelineStartSeconds - right.timelineStartSeconds,
    );
    expect(splitClips[0]?.timelineStartSeconds).toBeCloseTo(
      originalClip.timelineStartSeconds,
      3,
    );
    expect(splitClips[0]?.durationSeconds).toBeCloseTo(
      originalClip.durationSeconds / 2,
      3,
    );
    expect(splitClips[1]?.timelineStartSeconds).toBeCloseTo(splitSeconds, 3);
    expect(splitClips[1]?.durationSeconds).toBeCloseTo(
      originalClip.durationSeconds / 2,
      3,
    );

    const firstHalf = splitClips[0];
    if (!firstHalf) {
      throw new Error("The first split clip is missing before duplication");
    }
    const splitIds = new Set(splitClips.map((clip) => clip.id));
    menu = await openClipContextMenu(firstHalf);
    const duplicateButton = await menu.$("button*=Duplicar");
    await duplicateButton.waitForClickable();
    await duplicateButton.click();
    await browser.waitUntil(
      async () => (await AppPage.songView())?.clips.length === 3,
      {
        timeout: 30_000,
        timeoutMsg: "Duplicating the split clip did not update the backend model",
      },
    );

    const duplicate = (await AppPage.songView())?.clips.find(
      (clip) => !splitIds.has(clip.id),
    );
    expect(duplicate?.trackId).toBe(originalClip.trackId);
    expect(duplicate?.timelineStartSeconds).toBeCloseTo(splitSeconds, 3);
    expect(duplicate?.durationSeconds).toBeCloseTo(
      originalClip.durationSeconds / 2,
      3,
    );
  });

  it("organizes and removes library assets through virtual folders", async () => {
    await AppPage.openLibrary();
    await (await AppPage.libraryFolderButton).click();

    let input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Folder");
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () => (await AppPage.libraryState()).folders.includes("E2E Folder"),
      {
        timeout: 30_000,
        timeoutMsg: "The virtual folder was not created in the backend",
      },
    );

    let folderSummary = await $(
      '.lt-library-folder-summary[data-library-folder-path="E2E Folder"]',
    );
    const asset = await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME);
    await asset.dragAndDrop(folderSummary);
    await browser.waitUntil(
      async () =>
        (await AppPage.libraryState()).assets.find(
          (candidate) => candidate.fileName === UNUSED_AUDIO_FILE_NAME,
        )?.folderPath === "E2E Folder",
      {
        timeout: 30_000,
        timeoutMsg: "Dragging the asset did not move it into the virtual folder",
      },
    );

    await folderSummary.click({ button: "right" });
    let menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Renombrar carpeta")).click();

    input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Renamed Folder");
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () => {
        const state = await AppPage.libraryState();
        return (
          state.folders.includes("E2E Renamed Folder") &&
          !state.folders.includes("E2E Folder") &&
          state.assets.find(
            (candidate) => candidate.fileName === UNUSED_AUDIO_FILE_NAME,
          )?.folderPath === "E2E Renamed Folder"
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "Renaming the folder did not update its asset in the backend",
      },
    );

    const movedAsset = await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME);
    await movedAsset.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Mover a la raiz")).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.libraryState()).assets.find(
          (candidate) => candidate.fileName === UNUSED_AUDIO_FILE_NAME,
        )?.folderPath == null,
      {
        timeout: 30_000,
        timeoutMsg: "Moving the asset to the library root did not persist",
      },
    );

    folderSummary = await $(
      '.lt-library-folder-summary[data-library-folder-path="E2E Renamed Folder"]',
    );
    await folderSummary.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Eliminar carpeta")).click();
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () =>
        !(await AppPage.libraryState()).folders.includes("E2E Renamed Folder"),
      {
        timeout: 30_000,
        timeoutMsg: "Deleting the virtual folder did not persist",
      },
    );

    const rootAsset = await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME);
    await rootAsset.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button*=Borrar")).click();
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () =>
        !(await AppPage.libraryState()).assets.some(
          (candidate) => candidate.fileName === UNUSED_AUDIO_FILE_NAME,
        ),
      {
        timeout: 30_000,
        timeoutMsg: "Deleting the library asset did not persist",
      },
    );
    await expect(
      await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME),
    ).not.toBeExisting();
  });

  it("seeks the engine and persists wheel zoom and horizontal pan", async () => {
    const ruler = await AppPage.timelineRuler;
    const rulerSize = await ruler.getSize();
    const viewBeforeSeek = await AppPage.timelineView();
    const song = await AppPage.songView();
    const seekSeconds = Math.min(1, (song?.durationSeconds ?? 1) / 2);
    const seekFromLeft =
      seekSeconds * viewBeforeSeek.zoomLevel * 18 - viewBeforeSeek.cameraX;

    await ruler.click({
      x: Math.round(seekFromLeft - rulerSize.width / 2),
      y: 0,
    });
    await browser.waitUntil(
      async () =>
        Math.abs(
          (await AppPage.transportSnapshot()).positionSeconds - seekSeconds,
        ) < 0.05,
      {
        timeout: 30_000,
        timeoutMsg: "Ruler seek never reached the native transport snapshot",
      },
    );

    const viewBeforeZoom = await AppPage.timelineView();
    await zoomTimelineWithWheel(ruler, -200);
    await browser.waitUntil(
      async () => (await AppPage.timelineView()).zoomLevel > viewBeforeZoom.zoomLevel,
      {
        timeout: 10_000,
        timeoutMsg: "Ctrl+wheel did not commit a larger timeline zoom",
      },
    );

    const viewBeforePan = await AppPage.timelineView();
    await browser
      .action("wheel")
      .scroll({
        origin: ruler,
        deltaX: 240,
        deltaY: 0,
        duration: 100,
      })
      .perform();
    await browser.waitUntil(
      async () => (await AppPage.timelineView()).cameraX > viewBeforePan.cameraX,
      {
        timeout: 10_000,
        timeoutMsg: "Horizontal wheel did not commit the timeline camera pan",
      },
    );
  });

  it("round-trips transport controls and the metronome toggle to the engine", async () => {
    await (await AppPage.playButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "playing",
      { timeoutMsg: "The engine never entered playing state" },
    );

    await (await AppPage.pauseButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "paused",
      { timeoutMsg: "The engine never entered paused state" },
    );

    await (await AppPage.stopButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "stopped",
      { timeoutMsg: "The engine never entered stopped state" },
    );

    const expectedMetronome = !initialMetronomeEnabled;
    await (await AppPage.metronomeButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.settings()).metronomeEnabled === expectedMetronome,
      {
        timeout: 30_000,
        timeoutMsg:
          "The realtime metronome command did not complete and persist",
      },
    );
    const metronomeClass = await (
      await AppPage.metronomeButton
    ).getAttribute("class");
    if (expectedMetronome) {
      expect(metronomeClass).toContain("is-active");
    } else {
      expect(metronomeClass).not.toContain("is-active");
    }
  });
});
