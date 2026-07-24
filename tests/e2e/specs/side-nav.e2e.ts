import { expect, $ } from "@wdio/globals";
import AppPage from "../pageobjects/app.page.js";

/**
 * The desktop side-nav is present on the landing (no session required) and
 * exposes three panels: Biblioteca (library), Remote, and Configuracion
 * (settings). This spec verifies each button exists, is enabled without a
 * session, and toggles its panel open — a real user interaction that
 * round-trips through the app without audio, filesystem writes, or a native
 * dialog.
 *
 * The project's toggle convention is an `is-active` class stamped on the
 * side-nav button while its panel/modal is open. Waiting on that single, stable
 * selector is far cheaper than polling document.innerText, which — with the
 * service's per-command script injection — balloons into thousands of
 * executeAsyncScript calls.
 */
describe("Side-nav panels", () => {
  before(async () => {
    await AppPage.waitUntilBooted();
    // A prior spec may have left a modal open; start from a neutral shell.
    await AppPage.resetShell();
  });

  after(async () => {
    // Leave the shell neutral for whatever spec runs next.
    await AppPage.resetShell();
  });

  it("exposes the three panel buttons, enabled without a session", async () => {
    for (const button of [
      await AppPage.libraryNavButton,
      await AppPage.remoteNavButton,
      await AppPage.settingsNavButton,
    ]) {
      await expect(button).toBeDisplayed();
      await expect(button).toBeEnabled();
    }
  });

  it("opens the Biblioteca (library) panel and toggles it closed", async () => {
    const library = await AppPage.libraryNavButton;
    await library.waitForClickable({ timeout: 20_000 });
    await library.click();

    // Once open, the side-nav button carries the active-state class.
    await $('button[aria-label="Biblioteca"].is-active').waitForExist({
      timeout: 15_000,
      timeoutMsg: "Library panel did not open after clicking Biblioteca",
    });

    // Clicking again toggles it shut — the active class is dropped.
    await library.click();
    await $('button[aria-label="Biblioteca"].is-active').waitForExist({
      reverse: true,
      timeout: 15_000,
      timeoutMsg: "Library panel did not close on second click",
    });
  });

  it("opens the Remote modal from the side nav", async () => {
    const remote = await AppPage.remoteNavButton;
    await remote.waitForClickable({ timeout: 20_000 });
    await remote.click();

    await $('button[aria-label="Remote"].is-active').waitForExist({
      timeout: 15_000,
      timeoutMsg: "Remote panel did not open after clicking Remote",
    });
  });
});
