import { browser, $ } from "@wdio/globals";

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
}

export default new AppPage();
