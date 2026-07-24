import { useEffect } from "react";
import type {
  AppSettings,
  LibraryAssetSummary,
  AudioOutputMeterLevel,
  AudioOutputCapture,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";
import {
  getLibraryAssets,
  getLibraryFolders,
  getAudioOutputMeter,
  getAudioOutputCapture,
  getSettings,
  getSongView,
  getTransportSnapshot,
  createUserPad,
  assignPadKey,
  setPadConfigRealtime,
  loadPadKey,
  deletePad,
  saveSettings,
  createAudioTracksWithClips,
  createSongRegion,
  createSectionMarker,
  deleteTracks,
  moveClip,
  moveClipsBatch,
  updateClipWindow,
  deleteClips,
  moveSongRegion,
  updateSongRegion,
  deleteSongRegion,
  splitSongRegion,
  updateSectionMarker,
  deleteSectionMarker,
  undoAction,
  redoAction,
  updateSongTempo,
  updateSongTimeSignature,
  upsertSongTempoMarker,
  deleteSongTempoMarker,
  upsertSongTimeSignatureMarker,
  deleteSongTimeSignatureMarker,
  resolveMissingFile,
  saveSessionAsTemplateAt,
  createSongFromTemplateNamed,
  listSessionTemplates,
  exportRegionAsPackageAt,
  type ClipMoveRequest,
} from "../desktopApi";
import { useTransportStore, type MeterDictionary } from "../store";
import { useTimelineUIStore } from "../uiStore";

/**
 * Exposes a tiny, stable automation surface on `window.__ltE2E` — but ONLY when
 * the page is being driven by WebDriver (`navigator.webdriver === true`). In a
 * normal user session the hook is inert and nothing is attached to `window`.
 *
 * Why this exists: the E2E suite drives the real app, and the create/open-session
 * entry points open a NATIVE file dialog (`rfd`) that WebDriver cannot pilot.
 * Rather than reach for the dialog, tests call the same frontend handlers a user
 * click would, so the flow — invoke, await the `project:load-complete` event,
 * apply the snapshot to React state — runs identically to production. The
 * handlers already accept explicit paths (the Android landing uses them without
 * a dialog), so a test can create a session inside a temp folder it controls.
 *
 * Keep this surface minimal and stable: it is a test seam, not a public API.
 */
export interface E2ETestHooks {
  /** Create a session named `name` inside `parentDir` (a real filesystem path). */
  createSessionNamed: (name: string, parentDir?: string) => void;
  /** Open an existing session from its `.ltsession` file path. */
  openSessionFromPath: (songFile: string) => void;
  /** Import native audio paths through the production library-only pipeline. */
  importLibraryAudioFromPaths: (paths: string[]) => Promise<void>;
  /** Read-only backend observations used to assert completed E2E round trips. */
  getSongView: () => Promise<SongView | null>;
  getTransportSnapshot: () => Promise<TransportSnapshot>;
  getSettings: () => Promise<AppSettings>;
  getTimelineView: () => { cameraX: number; zoomLevel: number };
  getTrackMeters: () => MeterDictionary;
  getAudioOutputMeter: () => Promise<AudioOutputMeterLevel>;
  /** Capture the most recent final stereo output for spectral (FFT) analysis. */
  getAudioOutputCapture: () => Promise<AudioOutputCapture>;
  getLibraryState: () => Promise<{
    assets: LibraryAssetSummary[];
    folders: string[];
  }>;
  /**
   * Create a user pad, assign `sourcePath` to key C (index 0), and enable the
   * pad through the production realtime config + key-load path. Returns the new
   * pad id. Pads are transport-decoupled, so it starts sounding without play.
   */
  activatePadWithTone: (sourcePath: string) => Promise<string>;
  /** Disable the pad and delete the given user pad, restoring neutral state. */
  deactivatePad: (padId: string) => Promise<void>;

  // --- Timeline fixture builders (self-contained edit flows) --------------
  // Let an edit flow build its own disposable tracks/clips/region and tear
  // them down, so it never mutates the canonical song other flows rely on.

  /** Create one audio track + clip per request; returns the new clip ids. */
  createAudioTracksWithClips: (
    requests: Array<{
      trackName: string;
      filePath: string;
      timelineStartSeconds: number;
    }>,
  ) => Promise<string[]>;
  /** Create an empty song region spanning [startSeconds, endSeconds). */
  createSongRegion: (startSeconds: number, endSeconds: number) => Promise<void>;
  /** Create a custom section marker at `startSeconds`; returns its id. */
  createSectionMarker: (startSeconds: number) => Promise<string>;
  /** Delete tracks (and their clips) in one transaction — flow teardown. */
  deleteTracks: (trackIds: string[]) => Promise<void>;

  // --- Timeline edits (drag/resize equivalents) --------------------------
  // These call the SAME shared commands a canvas drag or resize gesture
  // invokes; the canvas hit-testing is not itself driven (WebDriver cannot
  // pilot a <canvas>), but the backend edit + its invariants are exercised
  // identically. Tests assert against getSongView(). A rejected promise
  // surfaces the backend's rejection for the negative cases (region
  // collision, out-of-source clip window).

  /** Move one clip to an absolute timeline position (drag a single clip). */
  moveClip: (clipId: string, timelineStartSeconds: number) => Promise<void>;
  /**
   * Move several clips at once, optionally reassigning a clip's track
   * (multi-selection drag; `targetTrackId` = vertical drag onto a lane).
   */
  moveClipsBatch: (moves: ClipMoveRequest[]) => Promise<void>;
  /**
   * Resize/trim a clip's window (timeline start, source start, duration).
   * Rejects if the window falls outside the decoded source audio.
   */
  updateClipWindow: (
    clipId: string,
    timelineStartSeconds: number,
    sourceStartSeconds: number,
    durationSeconds: number,
  ) => Promise<void>;
  /** Delete a multi-selection of clips in one backend transaction. */
  deleteClips: (clipIds: string[]) => Promise<void>;
  /**
   * Translate a whole region by `deltaSeconds` (drag a region). Rejects a
   * leftward move that would overlap the preceding region; a rightward move
   * cascade-pushes the following regions instead.
   */
  moveSongRegion: (regionId: string, deltaSeconds: number) => Promise<void>;
  /** Resize a region by setting new absolute bounds (drag a region edge). */
  updateSongRegion: (
    regionId: string,
    name: string,
    startSeconds: number,
    endSeconds: number,
  ) => Promise<void>;
  /** Delete a region. */
  deleteSongRegion: (regionId: string) => Promise<void>;
  /** Split a region at an absolute timeline position. */
  splitSongRegion: (regionId: string, splitSeconds: number) => Promise<void>;
  /** Move a section marker (drag it along the ruler) / rename it. */
  updateSectionMarker: (
    sectionId: string,
    name: string,
    startSeconds: number,
  ) => Promise<void>;
  /** Delete a section marker. */
  deleteSectionMarker: (sectionId: string) => Promise<void>;
  /**
   * Undo the last structural edit (backend history stack). A no-op when the
   * undo stack is empty (resolves without changing the model).
   */
  undoAction: () => Promise<void>;
  /** Redo the last undone edit. A no-op when the redo stack is empty. */
  redoAction: () => Promise<void>;
  /** Set the song's base tempo (BPM). Rejects outside 20..300. */
  updateSongTempo: (bpm: number) => Promise<void>;
  /** Set the song's base time signature ("N/D"). Rejects an invalid string. */
  updateSongTimeSignature: (signature: string) => Promise<void>;
  /**
   * Upsert a tempo marker. At startSeconds ~= 0 this sets the base tempo
   * instead of creating a marker; at startSeconds > 0 it creates/updates one.
   */
  upsertSongTempoMarker: (startSeconds: number, bpm: number) => Promise<void>;
  /** Delete a tempo marker by id. */
  deleteSongTempoMarker: (markerId: string) => Promise<void>;
  /** Upsert a time-signature marker (base at ~0, marker at > 0). */
  upsertSongTimeSignatureMarker: (
    startSeconds: number,
    signature: string,
  ) => Promise<void>;
  /** Delete a time-signature marker by id. */
  deleteSongTimeSignatureMarker: (markerId: string) => Promise<void>;
  /**
   * Repoint every clip (and library manifest entry) whose file path is
   * `oldPath` to `newPath` — the "locate a missing audio file" flow. Clears the
   * clip's `isMissing` flag once the new path exists on disk.
   */
  resolveMissingFile: (oldPath: string, newPath: string) => Promise<void>;
  /**
   * Save the current session as a `.lttemplate` at an explicit path (no native
   * dialog). Returns the path back for convenience.
   */
  saveSessionAsTemplateAt: (templatePath: string) => Promise<string>;
  /** List the `.lttemplate` files in the default templates folder. */
  listSessionTemplates: () => Promise<Array<{ name: string; path: string }>>;
  /**
   * Create a new session named `name` in `parentDir` from the template at
   * `templatePath`, through the production project-load flow (no dialog).
   */
  createSessionFromTemplate: (
    templatePath: string,
    name: string,
    parentDir: string,
  ) => void;
  /**
   * Export a region (song) as a `.ltpkg` to an explicit path (no dialog).
   * Resolves true on success. `includeAudio` bundles the clip audio.
   */
  exportRegionAsPackageAt: (
    regionId: string,
    writePath: string,
    includeAudio: boolean,
  ) => Promise<boolean>;
}

type E2EWindow = Window & { __ltE2E?: E2ETestHooks };

/**
 * @param createSessionNamed create a session named `name` inside `parentDir`.
 * @param openSessionFromPath open an existing session from its `.ltsession` path.
 * @param importLibraryAudioFromPaths import explicit paths without a native picker.
 */
export function useE2ETestHooks(
  createSessionNamed: E2ETestHooks["createSessionNamed"],
  openSessionFromPath: E2ETestHooks["openSessionFromPath"],
  importLibraryAudioFromPaths: E2ETestHooks["importLibraryAudioFromPaths"],
): void {
  useEffect(() => {
    // Gate on WebDriver so the seam never exists in a real user session.
    if (typeof navigator === "undefined" || navigator.webdriver !== true) {
      return;
    }

    const target = window as E2EWindow;
    target.__ltE2E = {
      createSessionNamed,
      openSessionFromPath,
      importLibraryAudioFromPaths,
      getSongView: () => getSongView({ includeWaveforms: false }),
      getTransportSnapshot,
      getSettings,
      getTimelineView: () => {
        const { cameraX, zoomLevel } = useTimelineUIStore.getState();
        return { cameraX, zoomLevel };
      },
      getTrackMeters: () => useTransportStore.getState().meters,
      getAudioOutputMeter,
      getAudioOutputCapture,
      getLibraryState: async () => {
        const [assets, folders] = await Promise.all([
          getLibraryAssets(),
          getLibraryFolders(),
        ]);
        return { assets, folders };
      },
      activatePadWithTone: async (sourcePath: string) => {
        const pad = await createUserPad("E2E Pad");
        // Assign the tone to key C (index 0) and select that key.
        await assignPadKey(pad.id, 0, sourcePath);
        const base = await getSettings();
        const next: AppSettings = {
          ...base,
          padEnabled: true,
          padId: pad.id,
          padKey: 0,
          padFollowSongKey: false,
          padVolume: 1,
        };
        // load_pad_key decodes + swaps the key in; set_pad_config_realtime
        // enables it. Both mirror the production PadsPopover path.
        await loadPadKey(next);
        await setPadConfigRealtime(next);
        await saveSettings(next);
        return pad.id;
      },
      deactivatePad: async (padId: string) => {
        const base = await getSettings();
        const off: AppSettings = { ...base, padEnabled: false, padId: "" };
        await setPadConfigRealtime(off);
        await saveSettings(off);
        await deletePad(padId);
      },

      // Fixture builders — let an edit flow stand up its own disposable
      // tracks/clips/region and tear them down without touching the canonical
      // song. Returns the created clip ids so the flow can address them.
      createAudioTracksWithClips: async (requests) => {
        const before = new Set(
          ((await getSongView({ includeWaveforms: false }))?.clips ?? []).map(
            (clip) => clip.id,
          ),
        );
        await createAudioTracksWithClips(requests);
        const after =
          (await getSongView({ includeWaveforms: false }))?.clips ?? [];
        return after
          .filter((clip) => !before.has(clip.id))
          .map((clip) => clip.id);
      },
      createSongRegion: async (startSeconds, endSeconds) => {
        await createSongRegion(startSeconds, endSeconds);
      },
      createSectionMarker: async (startSeconds) => {
        const before = new Set(
          (
            (await getSongView({ includeWaveforms: false }))?.sectionMarkers ??
            []
          ).map((marker) => marker.id),
        );
        await createSectionMarker(startSeconds);
        const after =
          (await getSongView({ includeWaveforms: false }))?.sectionMarkers ??
          [];
        return after.find((marker) => !before.has(marker.id))?.id ?? "";
      },
      deleteTracks: async (trackIds) => {
        await deleteTracks(trackIds);
      },

      // Timeline edits — thin wrappers over the shared commands. They return
      // void (tests observe the result via getSongView), but any backend
      // rejection propagates so a test can assert the negative case.
      moveClip: async (clipId, timelineStartSeconds) => {
        await moveClip(clipId, timelineStartSeconds);
      },
      moveClipsBatch: async (moves) => {
        await moveClipsBatch(moves);
      },
      updateClipWindow: async (
        clipId,
        timelineStartSeconds,
        sourceStartSeconds,
        durationSeconds,
      ) => {
        await updateClipWindow(
          clipId,
          timelineStartSeconds,
          sourceStartSeconds,
          durationSeconds,
        );
      },
      deleteClips: async (clipIds) => {
        await deleteClips(clipIds);
      },
      moveSongRegion: async (regionId, deltaSeconds) => {
        await moveSongRegion(regionId, deltaSeconds);
      },
      updateSongRegion: async (regionId, name, startSeconds, endSeconds) => {
        await updateSongRegion(regionId, name, startSeconds, endSeconds);
      },
      deleteSongRegion: async (regionId) => {
        await deleteSongRegion(regionId);
      },
      splitSongRegion: async (regionId, splitSeconds) => {
        await splitSongRegion(regionId, splitSeconds);
      },
      updateSectionMarker: async (sectionId, name, startSeconds) => {
        await updateSectionMarker(sectionId, name, startSeconds);
      },
      deleteSectionMarker: async (sectionId) => {
        await deleteSectionMarker(sectionId);
      },
      undoAction: async () => {
        await undoAction();
      },
      redoAction: async () => {
        await redoAction();
      },
      updateSongTempo: async (bpm) => {
        await updateSongTempo(bpm);
      },
      updateSongTimeSignature: async (signature) => {
        await updateSongTimeSignature(signature);
      },
      upsertSongTempoMarker: async (startSeconds, bpm) => {
        await upsertSongTempoMarker(startSeconds, bpm);
      },
      deleteSongTempoMarker: async (markerId) => {
        await deleteSongTempoMarker(markerId);
      },
      upsertSongTimeSignatureMarker: async (startSeconds, signature) => {
        await upsertSongTimeSignatureMarker(startSeconds, signature);
      },
      deleteSongTimeSignatureMarker: async (markerId) => {
        await deleteSongTimeSignatureMarker(markerId);
      },
      resolveMissingFile: async (oldPath, newPath) => {
        await resolveMissingFile(oldPath, newPath);
      },
      saveSessionAsTemplateAt: async (templatePath) => {
        await saveSessionAsTemplateAt(templatePath);
        return templatePath;
      },
      listSessionTemplates: () => listSessionTemplates(),
      createSessionFromTemplate: (templatePath, name, parentDir) => {
        void createSongFromTemplateNamed(templatePath, name, parentDir);
      },
      exportRegionAsPackageAt: (regionId, writePath, includeAudio) =>
        exportRegionAsPackageAt(regionId, writePath, includeAudio),
    };

    return () => {
      delete target.__ltE2E;
    };
  }, [
    createSessionNamed,
    importLibraryAudioFromPaths,
    openSessionFromPath,
  ]);
}
