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

  it("shows the create-or-open-session landing", async () => {
    const heading = await AppPage.landingHeading;
    await heading.waitForDisplayed({ timeout: 20_000 });
    // The landing <h1> — assert on a stable, accent-insensitive substring.
    expect((await heading.getText()).toLowerCase()).toContain("sesi");

    await expect(await AppPage.createSessionButton).toBeDisplayed();
    await expect(await AppPage.openSessionButton).toBeDisplayed();
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
