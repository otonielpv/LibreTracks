import { browser, $, $$ } from "@wdio/globals";

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

  /** Transport play button (aria-label "Reproducir"). */
  get playButton() {
    return $('button[aria-label="Reproducir"]');
  }

  /** Transport stop button (aria-label "Detener"). */
  get stopButton() {
    return $('button[aria-label="Detener"]');
  }

  /** Metronome toggle (aria-label "Metronomo"). Round-trips to the engine. */
  get metronomeButton() {
    return $('button[aria-label="Metronomo"]');
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
