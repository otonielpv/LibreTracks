import { browser, $, $$ } from "@wdio/globals";

export type E2ESongView = {
  id: string;
  title: string;
  durationSeconds: number;
  bpm: number;
  timeSignature: string;
  tempoMarkers: Array<{
    id: string;
    startSeconds: number;
    bpm: number;
  }>;
  timeSignatureMarkers: Array<{
    id: string;
    startSeconds: number;
    signature: string;
  }>;
  tracks: Array<{
    id: string;
    name: string;
    kind: string;
    parentTrackId?: string | null;
    depth: number;
    volume: number;
    pan: number;
    muted: boolean;
    solo: boolean;
    transposeEnabled: boolean;
    color?: string | null;
  }>;
  clips: Array<{
    id: string;
    trackId: string;
    timelineStartSeconds: number;
    durationSeconds: number;
    filePath: string;
    color?: string | null;
    isMissing: boolean;
  }>;
  // The backend SongView carries these; the page object exposes just the fields
  // the region/marker flows assert on.
  regions: Array<{
    id: string;
    name: string;
    startSeconds: number;
    endSeconds: number;
    transposeSemitones: number;
    key: string | null;
    warpEnabled: boolean;
    warpSourceBpm: number | null;
    master?: { gain: number };
  }>;
  sectionMarkers: Array<{
    id: string;
    name: string;
    startSeconds: number;
    kind?: string;
    variant?: number | null;
    digit?: number | null;
    color?: string | null;
  }>;
  automationCues?: Array<{
    id: string;
    name: string;
    atSeconds: number;
    enabled: boolean;
  }>;
  mixScenes?: Array<{
    id: string;
    name: string;
  }>;
  automationTrack?: { id: string } | null;
};

export type E2ETransportSnapshot = {
  playbackState: string;
  positionSeconds: number;
  projectRevision: number;
  songFilePath: string | null;
};

export type E2ESettings = {
  metronomeEnabled: boolean;
  voiceGuideEnabled: boolean;
};

export type E2ETimelineView = {
  cameraX: number;
  zoomLevel: number;
};

export type E2ETrackMeters = Record<
  string,
  { leftPeak: number; rightPeak: number }
>;

export type E2EAudioOutputMeter = {
  leftPeak: number;
  rightPeak: number;
};

export type E2EAudioOutputCapture = {
  sampleRate: number;
  left: number[];
  right: number[];
};

export type E2ELibraryState = {
  assets: Array<{
    fileName: string;
    filePath: string;
    folderPath?: string | null;
  }>;
  folders: string[];
};

/**
 * Page Object for the LibreTracks desktop shell. Kept deliberately thin: it
 * exposes structural anchors that are stable regardless of session state (the
 * React root, the landing heading, the transport controls addressed by their
 * aria-labels) plus helpers the specs build on. Deep transport-monolith UI is
 * located per-spec so this object stays resilient to that file's churn.
 *
 * Locators favour role/aria-label over CSS classes, per Playwright/WDIO
 * best practice — the app labels its transport buttons in Spanish
 * ("Reproducir", "Detener", "Metronomo", ...).
 */
class AppPage {
  /** The React mount point from index.html. */
  get root() {
    return $("#root");
  }

  /** The landing screen's <h1> ("Crea o abre una sesión"). */
  get landingHeading() {
    return $("h1");
  }

  /** "Crear" button on the landing — starts a new session. */
  get createSessionButton() {
    return $("button=Crear");
  }

  /** "Abrir" button on the landing — opens an existing session. */
  get openSessionButton() {
    return $("button=Abrir");
  }

  /** "Importar sesión" button on the landing (imports a whole .ltset). */
  get importSessionButton() {
    return $("button=Importar sesión");
  }

  /** "Importar Reaper/Ableton" button on the landing (external-project wizard). */
  get importExternalProjectButton() {
    return $("button=Importar Reaper/Ableton");
  }

  /** The landing's card wrapper — present only on the empty (no-session) state. */
  get emptyStateCard() {
    return $(".lt-empty-state-card");
  }

  /** Templates column on the landing (shows saved .lttemplate files or an empty note). */
  get templatesColumn() {
    return $(".lt-empty-state-templates:not(.lt-empty-state-recents)");
  }

  /** Recents column on the landing (recently opened/created sessions). */
  get recentsColumn() {
    return $(".lt-empty-state-recents");
  }

  // --- Side-nav (present on the landing too) -------------------------------
  // The desktop side-nav exposes three panels regardless of session state.
  // Labels come from the resolved Spanish locale (unaccented in the source):
  // "Biblioteca", "Remote", "Configuracion".

  /** Side-nav "Biblioteca" (library) toggle. */
  get libraryNavButton() {
    return $('button[aria-label="Biblioteca"]');
  }

  /** Side-nav "Remote" toggle. */
  get remoteNavButton() {
    return $('button[aria-label="Remote"]');
  }

  /** Side-nav "Configuracion" (settings) toggle. */
  get settingsNavButton() {
    return $('button[aria-label="Configuracion"]');
  }

  // --- Settings modal ------------------------------------------------------
  // Opened from the side-nav; a role="tablist" with stable per-tab ids
  // (lt-settings-tab-<id>) and matching role="tabpanel" panels
  // (lt-settings-panel-<id>). Desktop tabs: audio, general, shortcuts,
  // diagnostics, midi, midiLearn. Default tab on open is "audio".

  /** The Settings modal's tablist container. */
  get settingsTabList() {
    return $('[role="tablist"].lt-settings-tablist');
  }

  /** A Settings tab button by id (e.g. "audio", "shortcuts"). */
  settingsTab(id: string) {
    return $(`#lt-settings-tab-${id}`);
  }

  /** A Settings tab panel by id — the visible section for the active tab. */
  settingsPanel(id: string) {
    return $(`#lt-settings-panel-${id}`);
  }

  /** Open the Settings modal via the side-nav and wait for it to render. */
  async openSettings() {
    const button = await this.settingsNavButton;
    await button.waitForClickable({ timeout: 20_000 });
    await button.click();
    await (await this.settingsTabList).waitForDisplayed({ timeout: 15_000 });
  }

  /** Search box inside the "Atajos" (shortcuts) tab. */
  get shortcutsSearch() {
    return $(".lt-shortcuts-search");
  }

  /** "Restablecer todo" button inside the shortcuts tab. */
  get shortcutsResetAll() {
    return $(".lt-shortcuts-reset-all");
  }

  /** All shortcut rows currently rendered in the shortcuts tab. */
  get shortcutRows() {
    return $$(".lt-shortcuts-row");
  }

  // --- Library panel -------------------------------------------------------
  // Toggled from the side-nav's Biblioteca button. Without a session
  // (canImport = false) its import/folder actions are disabled and the meta row
  // shows the "open or create a session" hint.

  /** The Library panel container (aria-label "Library panel"). */
  get libraryPanel() {
    return $('aside[aria-label="Library panel"]');
  }

  /** "Importar audio" button inside the Library panel. */
  get libraryImportButton() {
    return $(".lt-library-import-button");
  }

  /** "Carpeta" (create folder) button inside the Library panel. */
  get libraryFolderButton() {
    return $(".lt-library-folder-button");
  }

  /** The Library panel's empty-state note (shown with no assets/folders). */
  get libraryEmpty() {
    return $(".lt-library-panel-empty");
  }

  /** Open the Library panel via the side-nav and wait for it to render. */
  async openLibrary() {
    const button = await this.libraryNavButton;
    await button.waitForClickable({ timeout: 20_000 });
    await button.click();
    await (await this.libraryPanel).waitForDisplayed({ timeout: 15_000 });
  }

  /** Transport play button (aria-label "Reproducir"). */
  get playButton() {
    return $('button[aria-label="Reproducir"]');
  }

  /** Transport stop button (aria-label "Detener"). */
  get stopButton() {
    return $('button[aria-label="Detener"]');
  }

  /** Transport pause button (aria-label "Pausar"). */
  get pauseButton() {
    return $('button[aria-label="Pausar"]');
  }

  /** Metronome toggle (aria-label "Metronomo"). Round-trips to the engine. */
  get metronomeButton() {
    return $('button[aria-label="Metronomo"]');
  }

  // --- Session flows -------------------------------------------------------
  // With a session open the landing (empty-state) is gone and the timeline
  // shell mounts. Session creation goes through window.__ltE2E (exposed only
  // under WebDriver by useE2ETestHooks), which calls the SAME frontend handler
  // a user click would — so the invoke → project:load-complete → snapshot flow
  // runs exactly as in production, just without the native dialog.

  /** The timeline shell — present only once a session is open. */
  get timelineShell() {
    return $(".lt-timeline-shell");
  }

  /** Empty area in the track-header pane; its context menu creates tracks. */
  get trackHeadersList() {
    return $(".lt-track-headers-list");
  }

  /** Track-header pane, including the empty area below the final track. */
  get trackHeadersPane() {
    return $(".lt-track-headers-pane");
  }

  /** Timeline ruler; a click performs a real backend seek. */
  get timelineRuler() {
    return $(".lt-ruler-track");
  }

  /** A rendered audio-track lane by the backend track id. */
  trackLane(trackId: string) {
    return $(`.lt-track-lane-row[data-track-id="${trackId}"] .lt-track-lane`);
  }

  /** A library asset row by its stable accessible filename. */
  libraryAsset(fileName: string) {
    return $(`.lt-library-asset[aria-label="${fileName}"]`);
  }

  /** The empty-state landing card — present only when NO session is open. */
  get emptyStateCardMaybe() {
    return $(".lt-empty-state-card");
  }

  /**
   * Create a session named `name` inside `parentDir` (a real filesystem path
   * the caller controls, e.g. a temp folder) via the E2E hook, then wait for
   * the landing to disappear and the timeline shell to mount. Throws a clear
   * error if the hook isn't present (binary built without useE2ETestHooks, or
   * not running under WebDriver).
   */
  async createSession(name: string, parentDir: string, timeout = 60_000) {
    const hookPresent = await browser.execute(
      () =>
        typeof (window as unknown as { __ltE2E?: unknown }).__ltE2E ===
        "object",
    );
    if (!hookPresent) {
      throw new Error(
        "window.__ltE2E is not available — is the binary built with useE2ETestHooks and running under WebDriver?",
      );
    }

    await browser.execute(
      (n: string, p: string) =>
        (
          window as unknown as {
            __ltE2E: { createSessionNamed: (name: string, parent?: string) => void };
          }
        ).__ltE2E.createSessionNamed(n, p),
      name,
      parentDir,
    );

    // The landing card is unmounted and the timeline shell appears once the
    // project:load-complete snapshot is applied to React state.
    await (await this.timelineShell).waitForDisplayed({
      timeout,
      timeoutMsg: "Timeline shell never appeared after creating a session",
    });
  }

  /**
   * Open a known `.ltsession` through the production project-load flow and
   * wait for the expected persisted song identity to reach the backend.
   */
  /**
   * Reopen a `.ltsession` and wait until `predicate` holds on the reloaded song
   * model (plus the load overlay clears). Use when the reopened song id isn't
   * known ahead of time; assert on stable content (e.g. a track by name).
   */
  async reopenSessionUntil(
    songFile: string,
    predicate: (song: E2ESongView) => boolean,
    timeout = 60_000,
  ) {
    await browser.execute(
      (path: string) =>
        (
          window as unknown as {
            __ltE2E: { openSessionFromPath: (songFile: string) => void };
          }
        ).__ltE2E.openSessionFromPath(path),
      songFile,
    );
    await browser.waitUntil(
      async () => {
        const song = await this.songView();
        return song !== null && predicate(song);
      },
      { timeout, timeoutMsg: "The reopened session never matched the predicate" },
    );
    await (await $(".busy-overlay")).waitForExist({
      reverse: true,
      timeout,
      timeoutMsg: "Project load overlay remained visible after reopening",
    });
  }

  async openSession(
    songFile: string,
    expectedSongId: string,
    timeout = 60_000,
  ) {
    await browser.execute(
      (path: string) =>
        (
          window as unknown as {
            __ltE2E: { openSessionFromPath: (songFile: string) => void };
          }
        ).__ltE2E.openSessionFromPath(path),
      songFile,
    );

    await browser.waitUntil(
      async () => (await this.songView())?.id === expectedSongId,
      {
        timeout,
        timeoutMsg: `Session ${expectedSongId} never finished reopening`,
      },
    );
    await (await $(".busy-overlay")).waitForExist({
      reverse: true,
      timeout,
      timeoutMsg: "Project load overlay remained visible after reopening",
    });
  }

  /**
   * Import audio through the same library-only pipeline as the visible button,
   * supplying paths directly because WebDriver cannot operate rfd's native
   * file picker.
   */
  async importLibraryAudio(paths: string[]) {
    await browser.execute(
      async (sourcePaths: string[]) =>
        (
          window as unknown as {
            __ltE2E: {
              importLibraryAudioFromPaths: (paths: string[]) => Promise<void>;
            };
          }
        ).__ltE2E.importLibraryAudioFromPaths(sourcePaths),
      paths,
    );
  }

  /** Read the canonical song model from the backend (no waveform payload). */
  async songView(): Promise<E2ESongView | null> {
    return browser.execute(
      () =>
        (
          window as unknown as {
            __ltE2E: { getSongView: () => Promise<E2ESongView | null> };
          }
        ).__ltE2E.getSongView(),
    );
  }

  // --- Timeline fixture builders (self-contained edit flows) --------------

  /** Create one audio track + clip per request; resolves to the new clip ids. */
  async createAudioTracksWithClips(
    requests: Array<{
      trackName: string;
      filePath: string;
      timelineStartSeconds: number;
    }>,
  ): Promise<string[]> {
    return browser.execute(
      (reqs: unknown) =>
        (
          window as unknown as {
            __ltE2E: {
              createAudioTracksWithClips: (
                requests: unknown,
              ) => Promise<string[]>;
            };
          }
        ).__ltE2E.createAudioTracksWithClips(reqs),
      requests,
    );
  }

  /** Create an empty song region spanning [startSeconds, endSeconds). */
  async createSongRegion(
    startSeconds: number,
    endSeconds: number,
  ): Promise<void> {
    await browser.execute(
      (start: number, end: number) =>
        (
          window as unknown as {
            __ltE2E: {
              createSongRegion: (start: number, end: number) => Promise<void>;
            };
          }
        ).__ltE2E.createSongRegion(start, end),
      startSeconds,
      endSeconds,
    );
  }

  /** Create a custom section marker at `startSeconds`; resolves to its id. */
  async createSectionMarker(startSeconds: number): Promise<string> {
    return browser.execute(
      (at: number) =>
        (
          window as unknown as {
            __ltE2E: {
              createSectionMarker: (startSeconds: number) => Promise<string>;
            };
          }
        ).__ltE2E.createSectionMarker(at),
      startSeconds,
    );
  }

  /** Delete tracks (and their clips) in one transaction. */
  async deleteTracks(trackIds: string[]): Promise<void> {
    await browser.execute(
      (ids: string[]) =>
        (
          window as unknown as {
            __ltE2E: { deleteTracks: (trackIds: string[]) => Promise<void> };
          }
        ).__ltE2E.deleteTracks(ids),
      trackIds,
    );
  }

  // --- Timeline edits (drag/resize equivalents via the __ltE2E seam) -------
  // Each drives the SAME shared command a canvas gesture would; assert the
  // result via songView(). The mutating ones resolve to void; a rejected
  // backend promise (e.g. a region collision or an out-of-source clip window)
  // surfaces here so a spec can assert the negative case with expect().reject.

  /** Move one clip to an absolute timeline position. */
  async moveClip(clipId: string, timelineStartSeconds: number): Promise<void> {
    await browser.execute(
      (id: string, at: number) =>
        (
          window as unknown as {
            __ltE2E: {
              moveClip: (clipId: string, seconds: number) => Promise<void>;
            };
          }
        ).__ltE2E.moveClip(id, at),
      clipId,
      timelineStartSeconds,
    );
  }

  /** Move several clips at once (optionally reassigning `targetTrackId`). */
  async moveClipsBatch(
    moves: Array<{
      clipId: string;
      timelineStartSeconds: number;
      targetTrackId?: string;
    }>,
  ): Promise<void> {
    await browser.execute(
      (batch: unknown) =>
        (
          window as unknown as {
            __ltE2E: { moveClipsBatch: (moves: unknown) => Promise<void> };
          }
        ).__ltE2E.moveClipsBatch(batch),
      moves,
    );
  }

  /** Resize/trim a clip window; rejects if it falls outside the source audio. */
  async updateClipWindow(
    clipId: string,
    timelineStartSeconds: number,
    sourceStartSeconds: number,
    durationSeconds: number,
  ): Promise<void> {
    await browser.execute(
      (id: string, tl: number, src: number, dur: number) =>
        (
          window as unknown as {
            __ltE2E: {
              updateClipWindow: (
                clipId: string,
                timelineStartSeconds: number,
                sourceStartSeconds: number,
                durationSeconds: number,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.updateClipWindow(id, tl, src, dur),
      clipId,
      timelineStartSeconds,
      sourceStartSeconds,
      durationSeconds,
    );
  }

  /** Delete a multi-selection of clips in one backend transaction. */
  async deleteClips(clipIds: string[]): Promise<void> {
    await browser.execute(
      (ids: string[]) =>
        (
          window as unknown as {
            __ltE2E: { deleteClips: (clipIds: string[]) => Promise<void> };
          }
        ).__ltE2E.deleteClips(ids),
      clipIds,
    );
  }

  /** Translate a region by `deltaSeconds`; rejects a leftward overlap. */
  async moveSongRegion(regionId: string, deltaSeconds: number): Promise<void> {
    await browser.execute(
      (id: string, delta: number) =>
        (
          window as unknown as {
            __ltE2E: {
              moveSongRegion: (
                regionId: string,
                deltaSeconds: number,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.moveSongRegion(id, delta),
      regionId,
      deltaSeconds,
    );
  }

  /** Resize a region to new absolute bounds. */
  async updateSongRegion(
    regionId: string,
    name: string,
    startSeconds: number,
    endSeconds: number,
  ): Promise<void> {
    await browser.execute(
      (id: string, nm: string, start: number, end: number) =>
        (
          window as unknown as {
            __ltE2E: {
              updateSongRegion: (
                regionId: string,
                name: string,
                startSeconds: number,
                endSeconds: number,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.updateSongRegion(id, nm, start, end),
      regionId,
      name,
      startSeconds,
      endSeconds,
    );
  }

  /** Delete a region. */
  async deleteSongRegion(regionId: string): Promise<void> {
    await browser.execute(
      (id: string) =>
        (
          window as unknown as {
            __ltE2E: { deleteSongRegion: (regionId: string) => Promise<void> };
          }
        ).__ltE2E.deleteSongRegion(id),
      regionId,
    );
  }

  /** Split a region at an absolute timeline position. */
  async splitSongRegion(
    regionId: string,
    splitSeconds: number,
  ): Promise<void> {
    await browser.execute(
      (id: string, at: number) =>
        (
          window as unknown as {
            __ltE2E: {
              splitSongRegion: (
                regionId: string,
                splitSeconds: number,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.splitSongRegion(id, at),
      regionId,
      splitSeconds,
    );
  }

  /** Move / rename a section marker. */
  async updateSectionMarker(
    sectionId: string,
    name: string,
    startSeconds: number,
  ): Promise<void> {
    await browser.execute(
      (id: string, nm: string, at: number) =>
        (
          window as unknown as {
            __ltE2E: {
              updateSectionMarker: (
                sectionId: string,
                name: string,
                startSeconds: number,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.updateSectionMarker(id, nm, at),
      sectionId,
      name,
      startSeconds,
    );
  }

  /** Delete a section marker. */
  async deleteSectionMarker(sectionId: string): Promise<void> {
    await browser.execute(
      (id: string) =>
        (
          window as unknown as {
            __ltE2E: {
              deleteSectionMarker: (sectionId: string) => Promise<void>;
            };
          }
        ).__ltE2E.deleteSectionMarker(id),
      sectionId,
    );
  }

  /** Undo the last structural edit (backend history). No-op if nothing to undo. */
  async undoAction(): Promise<void> {
    await browser.execute(
      () =>
        (
          window as unknown as { __ltE2E: { undoAction: () => Promise<void> } }
        ).__ltE2E.undoAction(),
    );
  }

  /** Redo the last undone edit. No-op if nothing to redo. */
  async redoAction(): Promise<void> {
    await browser.execute(
      () =>
        (
          window as unknown as { __ltE2E: { redoAction: () => Promise<void> } }
        ).__ltE2E.redoAction(),
    );
  }

  /** Set the song's base tempo (BPM); rejects outside 20..300. */
  async updateSongTempo(bpm: number): Promise<void> {
    await browser.execute(
      (value: number) =>
        (
          window as unknown as {
            __ltE2E: { updateSongTempo: (bpm: number) => Promise<void> };
          }
        ).__ltE2E.updateSongTempo(value),
      bpm,
    );
  }

  /** Set the song's base time signature ("N/D"); rejects an invalid string. */
  async updateSongTimeSignature(signature: string): Promise<void> {
    await browser.execute(
      (value: string) =>
        (
          window as unknown as {
            __ltE2E: {
              updateSongTimeSignature: (signature: string) => Promise<void>;
            };
          }
        ).__ltE2E.updateSongTimeSignature(value),
      signature,
    );
  }

  /** Upsert a tempo marker (sets base tempo at ~0, a marker at > 0). */
  async upsertSongTempoMarker(
    startSeconds: number,
    bpm: number,
  ): Promise<void> {
    await browser.execute(
      (at: number, value: number) =>
        (
          window as unknown as {
            __ltE2E: {
              upsertSongTempoMarker: (
                startSeconds: number,
                bpm: number,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.upsertSongTempoMarker(at, value),
      startSeconds,
      bpm,
    );
  }

  /** Delete a tempo marker by id. */
  async deleteSongTempoMarker(markerId: string): Promise<void> {
    await browser.execute(
      (id: string) =>
        (
          window as unknown as {
            __ltE2E: {
              deleteSongTempoMarker: (markerId: string) => Promise<void>;
            };
          }
        ).__ltE2E.deleteSongTempoMarker(id),
      markerId,
    );
  }

  /** Upsert a time-signature marker (base at ~0, a marker at > 0). */
  async upsertSongTimeSignatureMarker(
    startSeconds: number,
    signature: string,
  ): Promise<void> {
    await browser.execute(
      (at: number, value: string) =>
        (
          window as unknown as {
            __ltE2E: {
              upsertSongTimeSignatureMarker: (
                startSeconds: number,
                signature: string,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.upsertSongTimeSignatureMarker(at, value),
      startSeconds,
      signature,
    );
  }

  /** Delete a time-signature marker by id. */
  async deleteSongTimeSignatureMarker(markerId: string): Promise<void> {
    await browser.execute(
      (id: string) =>
        (
          window as unknown as {
            __ltE2E: {
              deleteSongTimeSignatureMarker: (markerId: string) => Promise<void>;
            };
          }
        ).__ltE2E.deleteSongTimeSignatureMarker(id),
      markerId,
    );
  }

  /** Repoint clips from a missing `oldPath` to an existing `newPath`. */
  async resolveMissingFile(oldPath: string, newPath: string): Promise<void> {
    await browser.execute(
      (from: string, to: string) =>
        (
          window as unknown as {
            __ltE2E: {
              resolveMissingFile: (
                oldPath: string,
                newPath: string,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.resolveMissingFile(from, to),
      oldPath,
      newPath,
    );
  }

  /** Save the current session as a `.lttemplate` at an explicit path. */
  async saveSessionAsTemplateAt(templatePath: string): Promise<void> {
    await browser.execute(
      (p: string) =>
        (
          window as unknown as {
            __ltE2E: {
              saveSessionAsTemplateAt: (path: string) => Promise<string>;
            };
          }
        ).__ltE2E.saveSessionAsTemplateAt(p),
      templatePath,
    );
  }

  /** List the `.lttemplate` files in the default templates folder. */
  async listSessionTemplates(): Promise<Array<{ name: string; path: string }>> {
    return browser.execute(
      () =>
        (
          window as unknown as {
            __ltE2E: {
              listSessionTemplates: () => Promise<
                Array<{ name: string; path: string }>
              >;
            };
          }
        ).__ltE2E.listSessionTemplates(),
    );
  }

  /**
   * Create a new session from a template (no dialog) and wait for the timeline
   * shell to mount — the project-load flow unmounts the landing on completion.
   */
  async createSessionFromTemplate(
    templatePath: string,
    name: string,
    parentDir: string,
    timeout = 60_000,
  ): Promise<void> {
    await browser.execute(
      (tpl: string, n: string, dir: string) =>
        (
          window as unknown as {
            __ltE2E: {
              createSessionFromTemplate: (
                templatePath: string,
                name: string,
                parentDir: string,
              ) => void;
            };
          }
        ).__ltE2E.createSessionFromTemplate(tpl, n, dir),
      templatePath,
      name,
      parentDir,
    );
    await (await this.timelineShell).waitForDisplayed({
      timeout,
      timeoutMsg: "Timeline shell never appeared after creating from template",
    });
  }

  /** Export a region (song) as a `.ltpkg` to an explicit path; resolves true. */
  async exportRegionAsPackageAt(
    regionId: string,
    writePath: string,
    includeAudio: boolean,
  ): Promise<boolean> {
    return browser.execute(
      (id: string, p: string, audio: boolean) =>
        (
          window as unknown as {
            __ltE2E: {
              exportRegionAsPackageAt: (
                regionId: string,
                writePath: string,
                includeAudio: boolean,
              ) => Promise<boolean>;
            };
          }
        ).__ltE2E.exportRegionAsPackageAt(id, p, audio),
      regionId,
      writePath,
      includeAudio,
    );
  }

  /** Set a section marker's kind (and optional numbered variant). */
  async setSectionMarkerKind(
    sectionId: string,
    kind: string,
    variant: number | null,
  ): Promise<void> {
    await browser.execute(
      (id: string, k: string, v: number | null) =>
        (
          window as unknown as {
            __ltE2E: {
              setSectionMarkerKind: (
                sectionId: string,
                kind: string,
                variant: number | null,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.setSectionMarkerKind(id, k, v),
      sectionId,
      kind,
      variant,
    );
  }

  /** Set (or clear, with null) a section marker's colour override. */
  async setSectionMarkerColor(
    sectionId: string,
    color: string | null,
  ): Promise<void> {
    await browser.execute(
      (id: string, c: string | null) =>
        (
          window as unknown as {
            __ltE2E: {
              setSectionMarkerColor: (
                sectionId: string,
                color: string | null,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.setSectionMarkerColor(id, c),
      sectionId,
      color,
    );
  }

  /** Assign (or clear, with null) a section marker's quick-jump digit. */
  async assignSectionMarkerDigit(
    sectionId: string,
    digit: number | null,
  ): Promise<void> {
    await browser.execute(
      (id: string, d: number | null) =>
        (
          window as unknown as {
            __ltE2E: {
              assignSectionMarkerDigit: (
                sectionId: string,
                digit: number | null,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.assignSectionMarkerDigit(id, d),
      sectionId,
      digit,
    );
  }

  /** Create a track (audio or folder), optionally under a parent / after one. */
  async createTrack(args: {
    name: string;
    kind: "audio" | "folder";
    insertAfterTrackId?: string | null;
    parentTrackId?: string | null;
  }): Promise<void> {
    await browser.execute(
      (a: unknown) =>
        (
          window as unknown as {
            __ltE2E: { createTrack: (args: unknown) => Promise<void> };
          }
        ).__ltE2E.createTrack(a),
      args,
    );
  }

  /** Reorder / reparent a track. */
  async moveTrack(args: {
    trackId: string;
    insertAfterTrackId?: string | null;
    insertBeforeTrackId?: string | null;
    parentTrackId?: string | null;
  }): Promise<void> {
    await browser.execute(
      (a: unknown) =>
        (
          window as unknown as {
            __ltE2E: { moveTrack: (args: unknown) => Promise<void> };
          }
        ).__ltE2E.moveTrack(a),
      args,
    );
  }

  /** Set (or clear, with null) a track's colour. */
  async updateTrackColor(trackId: string, color: string | null): Promise<void> {
    await browser.execute(
      (id: string, c: string | null) =>
        (
          window as unknown as {
            __ltE2E: {
              updateTrackColor: (
                trackId: string,
                color: string | null,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.updateTrackColor(id, c),
      trackId,
      color,
    );
  }

  /** Set (or clear, with null) a clip's colour. */
  async updateClipColor(clipId: string, color: string | null): Promise<void> {
    await browser.execute(
      (id: string, c: string | null) =>
        (
          window as unknown as {
            __ltE2E: {
              updateClipColor: (
                clipId: string,
                color: string | null,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.updateClipColor(id, c),
      clipId,
      color,
    );
  }

  /**
   * Import a `.ltpkg` song package into the OPEN session at `insertAtSeconds`
   * (adds a new region). Fire-and-forget; the caller waits on the model.
   */
  async importSongPackageFromPath(
    packagePath: string,
    insertAtSeconds: number,
  ): Promise<void> {
    await browser.execute(
      (pkg: string, at: number) =>
        (
          window as unknown as {
            __ltE2E: {
              importSongPackageFromPath: (
                packagePath: string,
                insertAtSeconds: number,
              ) => void;
            };
          }
        ).__ltE2E.importSongPackageFromPath(pkg, at),
      packagePath,
      insertAtSeconds,
    );
  }

  /** Set a region's transpose in semitones. */
  async updateSongRegionTranspose(
    regionId: string,
    transposeSemitones: number,
  ): Promise<void> {
    await browser.execute(
      (id: string, semis: number) =>
        (
          window as unknown as {
            __ltE2E: {
              updateSongRegionTranspose: (
                regionId: string,
                transposeSemitones: number,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.updateSongRegionTranspose(id, semis),
      regionId,
      transposeSemitones,
    );
  }

  /** Set (or clear, with null) a region's musical key. */
  async updateSongRegionKey(
    regionId: string,
    key: string | null,
  ): Promise<void> {
    await browser.execute(
      (id: string, k: string | null) =>
        (
          window as unknown as {
            __ltE2E: {
              updateSongRegionKey: (
                regionId: string,
                key: string | null,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.updateSongRegionKey(id, k),
      regionId,
      key,
    );
  }

  /** Toggle warp on a region and/or set its source BPM. */
  async updateSongRegionWarp(
    regionId: string,
    warpEnabled: boolean,
    warpSourceBpm: number | null,
  ): Promise<void> {
    await browser.execute(
      (id: string, on: boolean, bpm: number | null) =>
        (
          window as unknown as {
            __ltE2E: {
              updateSongRegionWarp: (
                regionId: string,
                warpEnabled: boolean,
                warpSourceBpm: number | null,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.updateSongRegionWarp(id, on, bpm),
      regionId,
      warpEnabled,
      warpSourceBpm,
    );
  }

  /** Commit a region's master gain (linear multiplier). */
  async updateSongRegionMasterGain(
    regionId: string,
    masterGain: number,
  ): Promise<void> {
    await browser.execute(
      (id: string, gain: number) =>
        (
          window as unknown as {
            __ltE2E: {
              updateSongRegionMasterGain: (
                regionId: string,
                masterGain: number,
              ) => Promise<void>;
            };
          }
        ).__ltE2E.updateSongRegionMasterGain(id, gain),
      regionId,
      masterGain,
    );
  }

  /** Export the whole session as a `.ltset` to an explicit path; resolves true. */
  async exportSessionPackageAt(
    writePath: string,
    includeAudio: boolean,
  ): Promise<boolean> {
    return browser.execute(
      (p: string, audio: boolean) =>
        (
          window as unknown as {
            __ltE2E: {
              exportSessionPackageAt: (
                writePath: string,
                includeAudio: boolean,
              ) => Promise<boolean>;
            };
          }
        ).__ltE2E.exportSessionPackageAt(p, audio),
      writePath,
      includeAudio,
    );
  }

  /**
   * Import a `.ltset` as a new session under `targetSongDir` and wait for the
   * new project to open (the import replaces the current session on
   * project:load-complete).
   */
  async importSessionPackageAt(
    packagePath: string,
    targetSongDir: string,
    expectedSongFileHint: string,
    timeout = 60_000,
  ): Promise<void> {
    await browser.execute(
      (pkg: string, dir: string) =>
        (
          window as unknown as {
            __ltE2E: {
              importSessionPackageAt: (
                packagePath: string,
                targetSongDir: string,
              ) => void;
            };
          }
        ).__ltE2E.importSessionPackageAt(pkg, dir),
      packagePath,
      targetSongDir,
    );
    await browser.waitUntil(
      async () =>
        ((await this.transportSnapshot()).songFilePath ?? "").includes(
          expectedSongFileHint,
        ),
      {
        timeout,
        timeoutMsg: "The imported session never opened as a new project",
      },
    );
  }

  /** Read the canonical transport snapshot returned by the engine bridge. */
  async transportSnapshot(): Promise<E2ETransportSnapshot> {
    return browser.execute(
      () =>
        (
          window as unknown as {
            __ltE2E: {
              getTransportSnapshot: () => Promise<E2ETransportSnapshot>;
            };
          }
        ).__ltE2E.getTransportSnapshot(),
    );
  }

  /** Read persisted backend settings after a realtime engine toggle. */
  async settings(): Promise<E2ESettings> {
    return browser.execute(
      () =>
        (
          window as unknown as {
            __ltE2E: { getSettings: () => Promise<E2ESettings> };
          }
        ).__ltE2E.getSettings(),
    );
  }

  /** Read-only camera/zoom values used by the timeline's own hit testing. */
  async timelineView(): Promise<E2ETimelineView> {
    return browser.execute(
      () =>
        (
          window as unknown as {
            __ltE2E: { getTimelineView: () => E2ETimelineView };
          }
        ).__ltE2E.getTimelineView(),
    );
  }

  /** Read the latest pre-pan per-track peaks emitted by the native engine. */
  async trackMeters(): Promise<E2ETrackMeters> {
    return browser.execute(
      () =>
        (
          window as unknown as {
            __ltE2E: { getTrackMeters: () => E2ETrackMeters };
          }
        ).__ltE2E.getTrackMeters(),
    );
  }

  /** Read final stereo peaks from the native output bus after mixer controls. */
  async audioOutputMeter(): Promise<E2EAudioOutputMeter> {
    return browser.execute(
      () =>
        (
          window as unknown as {
            __ltE2E: {
              getAudioOutputMeter: () => Promise<E2EAudioOutputMeter>;
            };
          }
        ).__ltE2E.getAudioOutputMeter(),
    );
  }

  /** Capture the most recent final stereo output for spectral (FFT) analysis. */
  async audioOutputCapture(): Promise<E2EAudioOutputCapture> {
    return browser.execute(
      () =>
        (
          window as unknown as {
            __ltE2E: {
              getAudioOutputCapture: () => Promise<E2EAudioOutputCapture>;
            };
          }
        ).__ltE2E.getAudioOutputCapture(),
    );
  }

  /** Create a user pad from `sourcePath`, assign it to key C, and enable it. */
  async activatePadWithTone(sourcePath: string): Promise<string> {
    return browser.execute(
      (path: string) =>
        (
          window as unknown as {
            __ltE2E: {
              activatePadWithTone: (sourcePath: string) => Promise<string>;
            };
          }
        ).__ltE2E.activatePadWithTone(path),
      sourcePath,
    );
  }

  /** Disable the pad and delete the given user pad. */
  async deactivatePad(padId: string): Promise<void> {
    await browser.execute(
      (id: string) =>
        (
          window as unknown as {
            __ltE2E: { deactivatePad: (padId: string) => Promise<void> };
          }
        ).__ltE2E.deactivatePad(id),
      padId,
    );
  }

  /** Require measurable native rendered signal from one track. */
  async waitForTrackSignal(
    trackId: string,
    minimumPeak = 0.01,
    timeout = 30_000,
  ) {
    await browser.waitUntil(
      async () => {
        const meter = (await this.trackMeters())[trackId];
        return (
          meter !== undefined &&
          Math.max(meter.leftPeak, meter.rightPeak) > minimumPeak
        );
      },
      {
        timeout,
        timeoutMsg: `Track ${trackId} never emitted native rendered signal`,
      },
    );
  }

  /** Require several native meter samples at zero to reject transient silence. */
  async waitForTrackSilence(
    trackId: string,
    consecutiveSamples = 3,
    timeout = 30_000,
  ) {
    let silentSamples = 0;
    await browser.waitUntil(
      async () => {
        const meter = (await this.trackMeters())[trackId];
        if (
          meter !== undefined &&
          Math.max(meter.leftPeak, meter.rightPeak) <= 0.000_001
        ) {
          silentSamples += 1;
        } else {
          silentSamples = 0;
        }
        return silentSamples >= consecutiveSamples;
      },
      {
        timeout,
        interval: 100,
        timeoutMsg: `Track ${trackId} did not reach sustained rendered silence`,
      },
    );
  }

  /** Read the library manifest and virtual folders from the native backend. */
  async libraryState(): Promise<E2ELibraryState> {
    return browser.execute(
      () =>
        (
          window as unknown as {
            __ltE2E: { getLibraryState: () => Promise<E2ELibraryState> };
          }
        ).__ltE2E.getLibraryState(),
    );
  }

  /**
   * Resolves once React has rendered into #root — i.e. the WebView loaded the
   * bundle and the app booted, not just a blank document.
   */
  async waitUntilBooted(timeout = 60_000) {
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
        )) === true,
      {
        timeout,
        timeoutMsg: "React never rendered into #root (WebView did not boot)",
        interval: 250,
      },
    );
  }

  /** The document <title> the WebView reports for the loaded page. */
  async title() {
    return browser.getTitle();
  }

  /**
   * Return the shell to a neutral state: close any open Settings/Remote modal
   * (both dismiss on Escape) and collapse an open Biblioteca side panel. Specs
   * run against one long-lived app instance with no reload between them, so a
   * panel one spec opens is still open when the next starts. Call this from a
   * spec's `before`/`after` to keep it self-contained. Idempotent — safe to run
   * when nothing is open.
   */
  async resetShell() {
    await browser.keys(["Escape"]);
    const library = await this.libraryNavButton;
    if (
      (await library.isExisting()) &&
      (await library.getAttribute("class"))?.includes("is-active")
    ) {
      await library.click();
    }
  }
}

export default new AppPage();
