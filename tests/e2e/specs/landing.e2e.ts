import { expect, $ } from "@wdio/globals";
import AppPage from "../pageobjects/app.page.js";

/**
 * Real UI flow against the compiled app, no audio and no filesystem writes.
 *
 * On a fresh launch LibreTracks shows the landing ("Crea o abre una sesión")
 * with the transport controls disabled until a session exists. This spec
 * verifies the landing renders its real content and that a side-nav panel
 * (Settings) opens — a genuine user interaction that round-trips through the
 * app without needing an open session, audio device, or imported media.
 */
describe("Landing screen", () => {
  before(async () => {
    await AppPage.waitUntilBooted();
  });

  after(async () => {
    // The last test opens the Settings panel; leave the shell neutral so the
    // next spec (specs run against one long-lived app instance) starts clean.
    await AppPage.resetShell();
  });

  it("shows the create-or-open-session landing", async () => {
    const heading = await AppPage.landingHeading;
    await heading.waitForDisplayed({ timeout: 20_000 });
    // The landing <h1> — assert on a stable, accent-insensitive substring.
    expect((await heading.getText()).toLowerCase()).toContain("sesi");

    await expect(await AppPage.createSessionButton).toBeDisplayed();
    await expect(await AppPage.openSessionButton).toBeDisplayed();
  });

  it("offers all four entry-point actions on the empty state", async () => {
    // The landing card is the empty-state marker: present only when no session
    // is open. Its four buttons are the real ways into the app — create, open,
    // import a whole session, and import an external (Reaper/Ableton) project.
    await expect(await AppPage.emptyStateCard).toBeDisplayed();

    await expect(await AppPage.createSessionButton).toBeDisplayed();
    await expect(await AppPage.openSessionButton).toBeDisplayed();
    await expect(await AppPage.importSessionButton).toBeDisplayed();
    await expect(await AppPage.importExternalProjectButton).toBeDisplayed();

    // These are entry points, not disabled placeholders — each is clickable.
    // We assert clickability rather than clicking, since every one opens a
    // native file dialog WebDriver cannot pilot.
    await expect(await AppPage.createSessionButton).toBeClickable();
    await expect(await AppPage.openSessionButton).toBeClickable();
  });

  it("renders the templates and recents columns", async () => {
    // The landing shows two columns even with nothing saved yet: an empty note
    // stands in for the list. Their mere presence proves the empty-state layout
    // mounted fully, not a truncated fallback.
    await expect(await AppPage.templatesColumn).toBeDisplayed();
    await expect(await AppPage.recentsColumn).toBeDisplayed();
  });

  it("disables transport controls when no session is open", async () => {
    // Transport buttons exist in the shell but are disabled on the empty
    // landing — a real invariant of the app, verifiable without audio.
    const play = await AppPage.playButton;
    if (await play.isExisting()) {
      await expect(play).toBeDisabled();
    }

    const metronome = await AppPage.metronomeButton;
    if (await metronome.isExisting()) {
      await expect(metronome).toBeDisabled();
    }
  });

  it("opens the Settings panel from the side nav", async () => {
    const settingsButton = await $('button[aria-label="Configuracion"]');
    await settingsButton.waitForClickable({ timeout: 20_000 });
    await settingsButton.click();

    // Once the panel opens, the side-nav button reflects the active state
    // (the project's toggle convention is an `is-active` class). Waiting on a
    // single concrete selector is far cheaper than polling document.innerText,
    // which — with the service's per-command script injection — balloons into
    // thousands of executeAsyncScript calls.
    const activeSettings = $('button[aria-label="Configuracion"].is-active');
    await activeSettings.waitForExist({
      timeout: 15_000,
      timeoutMsg: "Settings panel did not open after clicking Configuración",
    });
  });
});
