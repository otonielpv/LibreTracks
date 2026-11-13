import { browser, expect } from "@wdio/globals";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { removeWorkDir } from "../utils/workdir.js";
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
  // The E2E runs against the real settings: a default song template there
  // would organise the source tracks into its own lanes and rename them.
  let savedSongTemplate: string | null = null;
  let savedSongLayout: "shared" | "songFolder" | "separate" = "shared";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    const settings = (await AppPage.settings()) as unknown as {
      defaultSongTemplate?: string | null;
      songTrackLayout?: typeof savedSongLayout;
    };
    savedSongTemplate = settings.defaultSongTemplate ?? null;
    savedSongLayout = settings.songTrackLayout ?? "shared";
    await AppPage.setSongTemplateSettings(null, "shared");

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
    await AppPage.setSongTemplateSettings(savedSongTemplate, savedSongLayout);
    removeWorkDir(workDir);
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

/**
 * Song templates: «+ Nueva canción» laid out from the built-in band template,
 * and a commercial multitrack dropped into the song with each stem landing
 * where its name says. Once per song track layout, each in its own session,
 * because the layouts disagree on what a second song does to the tracks.
 *
 * Drops go through create_clips_with_auto_tracks, the same command as a drop
 * on a compact-view column (and the mobile import). The track names come from
 * the template in the UI language, so the folders are matched in ES and EN.
 */
describe("Song templates (isolated sessions)", () => {
  const MULTITRACK = [
    "Way Maker - Click",
    "Way Maker - EG 1",
    "Way Maker - EG 2",
    "Way Maker - Keys",
    "Way Maker - Banjo",
  ];
  const GUITARS = /^(Guitarras|Guitars)$/;
  const KEYS = /^(Teclados|Keys)$/;
  const BAND_TARGETS = 9;

  let workDir = "";
  let stemPaths: string[] = [];
  let savedTemplate: string | null = null;
  let savedLayout: "shared" | "songFolder" | "separate" = "shared";

  type Song = NonNullable<Awaited<ReturnType<typeof AppPage.songView>>>;

  const trackOfStem = (song: Song, stem: string) => {
    const clip = song.clips.find((c) => c.filePath.replace(/\\/g, "/").endsWith(`${stem}.wav`));
    if (!clip) throw new Error(`No clip for ${stem}`);
    const track = song.tracks.find((t) => t.id === clip.trackId);
    if (!track) throw new Error(`No track for ${stem}`);
    return track;
  };
  const parentName = (song: Song, trackId: string) => {
    const track = song.tracks.find((t) => t.id === trackId);
    return song.tracks.find((t) => t.id === track?.parentTrackId)?.name ?? null;
  };

  /** Settle on the song view after a backend edit. */
  const songWhere = async (predicate: (song: Song) => boolean, message: string) => {
    let last: Song | null = null;
    await browser.waitUntil(
      async () => {
        last = await AppPage.songView();
        return last !== null && predicate(last);
      },
      { timeout: 30_000, timeoutMsg: message },
    );
    return last as unknown as Song;
  };

  const newSongAndDrop = async (name: string) => {
    const before = (await AppPage.songView())?.regions.length ?? 0;
    // null = the default template, the one Settings points at.
    await AppPage.createEmptySong(name, null);
    const withSong = await songWhere(
      (song) => song.regions.length === before + 1,
      `«${name}» was not created`,
    );
    const region = withSong.regions.find((r) => r.name === name) ?? withSong.regions[before];
    const clipsBefore = withSong.clips.length;
    await AppPage.createClipsWithAutoTracks(stemPaths, region.startSeconds);
    const dropped = await songWhere(
      (song) => song.clips.length === clipsBefore + stemPaths.length,
      `The multitrack never landed in «${name}»`,
    );
    return { song: dropped, regionId: region.id };
  };

  const startSession = async (name: string, layout: typeof savedLayout) => {
    await AppPage.setSongTemplateSettings("builtin:band", layout);
    const dir = path.join(workDir, layout);
    mkdirSync(dir, { recursive: true });
    await AppPage.createSession(name, dir);
  };

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    const settings = (await AppPage.settings()) as unknown as {
      defaultSongTemplate?: string | null;
      songTrackLayout?: typeof savedLayout;
    };
    savedTemplate = settings.defaultSongTemplate ?? null;
    savedLayout = settings.songTrackLayout ?? "shared";

    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-song-template-"));
    stemPaths = MULTITRACK.map((stem) => {
      const file = path.join(workDir, `${stem}.wav`);
      writeToneWav(file, 4);
      return file.replace(/\\/g, "/");
    });
  });

  after(async () => {
    // Settings outlive the spec: leave them as the next spec expects them.
    await AppPage.setSongTemplateSettings(savedTemplate, savedLayout);
    removeWorkDir(workDir);
  });

  it("shared: the songs fill the same lanes", async () => {
    await startSession("E2E Song Template Shared", "shared");

    const first = await newSongAndDrop("Way Maker");
    expect(trackOfStem(first.song, "Way Maker - Click").name).toBe("Click");
    const eg1 = trackOfStem(first.song, "Way Maker - EG 1");
    const eg2 = trackOfStem(first.song, "Way Maker - EG 2");
    expect(eg1.id).not.toBe(eg2.id);
    expect(parentName(first.song, eg1.id)).toMatch(GUITARS);
    expect(parentName(first.song, eg2.id)).toMatch(GUITARS);
    expect(parentName(first.song, trackOfStem(first.song, "Way Maker - Keys").id)).toMatch(KEYS);
    // Nothing in the template is a banjo: an ordinary auto track, as always.
    const banjo = trackOfStem(first.song, "Way Maker - Banjo");
    expect(banjo.autoCreated).toBe(true);
    expect(banjo.parentTrackId ?? null).toBeNull();

    // A second song with the same stems reuses the guitar lanes instead of
    // adding «EG 3» and «EG 4». Only the banjo gets a new auto track.
    const tracksAfterFirst = first.song.tracks.length;
    const second = await newSongAndDrop("Song Two");
    expect(trackOfStem(second.song, "Way Maker - EG 1").id).toBe(eg1.id);
    expect(trackOfStem(second.song, "Way Maker - EG 2").id).toBe(eg2.id);
    expect(second.song.tracks.length).toBe(tracksAfterFirst + 1);
  });

  it("songFolder: each song keeps its tracks in a folder named after it", async () => {
    await startSession("E2E Song Template Folder", "songFolder");

    const first = await newSongAndDrop("Way Maker");
    const second = await newSongAndDrop("Song Two");
    const song = second.song;

    for (const { regionId, name } of [
      { regionId: first.regionId, name: "Way Maker" },
      { regionId: second.regionId, name: "Song Two" },
    ]) {
      const folder = song.tracks.find(
        (t) => t.kind === "folder" && !t.parentTrackId && t.songRegionId === regionId,
      );
      expect(folder?.name).toBe(name);
      // Everything made for the song carries its id, the banjo included.
      const own = song.tracks.filter((t) => t.songRegionId === regionId);
      expect(own.length).toBeGreaterThan(BAND_TARGETS);
    }

    // The same stem name lands on a different track per song.
    const clicks = song.clips
      .filter((c) => c.filePath.replace(/\\/g, "/").endsWith("Way Maker - Click.wav"))
      .map((c) => c.trackId);
    expect(new Set(clicks).size).toBe(2);
  });

  it("separate: each song gets its own copy of the template at the root", async () => {
    await startSession("E2E Song Template Separate", "separate");

    const first = await newSongAndDrop("Way Maker");
    const second = await newSongAndDrop("Song Two");
    const song = second.song;

    const guitarFolders = song.tracks.filter((t) => t.kind === "folder" && GUITARS.test(t.name));
    expect(guitarFolders.length).toBe(2);
    expect(guitarFolders.every((t) => !t.parentTrackId)).toBe(true);
    expect(new Set(guitarFolders.map((t) => t.songRegionId))).toEqual(
      new Set([first.regionId, second.regionId]),
    );

    // Each song's EG 1 lives under that song's own guitar folder.
    const eg1Tracks = song.clips
      .filter((c) => c.filePath.replace(/\\/g, "/").endsWith("Way Maker - EG 1.wav"))
      .map((c) => song.tracks.find((t) => t.id === c.trackId));
    expect(new Set(eg1Tracks.map((t) => t?.songRegionId))).toEqual(
      new Set([first.regionId, second.regionId]),
    );
  });

  it("undo takes the whole organised drop back in one step", async () => {
    await startSession("E2E Song Template Undo", "shared");
    await AppPage.createEmptySong("Way Maker", null);
    const empty = await songWhere((song) => song.regions.length === 1, "No song to drop into");
    const templateTracks = empty.tracks.length;
    expect(templateTracks).toBe(BAND_TARGETS);

    await AppPage.createClipsWithAutoTracks(stemPaths, empty.regions[0].startSeconds);
    await songWhere((song) => song.clips.length === stemPaths.length, "The drop never landed");

    await AppPage.undoAction();
    const undone = await songWhere((song) => song.clips.length === 0, "Undo left clips behind");
    expect(undone.tracks.length).toBe(templateTracks);
  });
});
