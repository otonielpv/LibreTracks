import { browser, $, $$ } from "@wdio/globals";

export type E2ESongView = {
  id: string;
  title: string;
  durationSeconds: number;
  tracks: Array<{
    id: string;
    name: string;
    kind: string;
    volume: number;
    pan: number;
    muted: boolean;
    solo: boolean;
  }>;
  clips: Array<{
    id: string;
    trackId: string;
    timelineStartSeconds: number;
    durationSeconds: number;
  }>;
};

export type E2ETransportSnapshot = {
  playbackState: string;
  positionSeconds: number;
  projectRevision: number;
  songFilePath: string | null;
};

export type E2ESettings = {
  metronomeEnabled: boolean;
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
