import { expect } from "@wdio/globals";
import AppPage from "../pageobjects/app.page.js";

/**
 * The Library panel opens from the side-nav with no session. Without an open
 * session its import/folder actions are disabled (canImport = false) and it
 * shows its empty state — a real invariant verifiable without audio, a native
 * dialog, or filesystem writes. This spec drives the panel open and asserts
 * that no-session state.
 *
 * Locators favour the panel's aria-label and stable class hooks. We wait on
 * concrete selectors rather than polling document.innerText, which — with the
 * service's per-command script injection — balloons into thousands of
 * executeAsyncScript calls.
 */
describe("Library panel", () => {
  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    await AppPage.openLibrary();
  });

  after(async () => {
    // Leave the shell neutral for the next spec.
    await AppPage.resetShell();
  });

  it("renders the Library panel with its header", async () => {
    const panel = await AppPage.libraryPanel;
    await expect(panel).toBeDisplayed();

    // The panel's <h2> title ("Biblioteca") anchors the header rendered.
    const heading = await panel.$("h2");
    await expect(heading).toBeDisplayed();
    expect((await heading.getText()).toLowerCase()).toContain("bibliotec");
  });

  it("disables the import and create-folder actions with no session", async () => {
    // canImport is Boolean(playbackSongDir); with no session it is false, so
    // both actions are disabled — the app's real gate on importing before a
    // session exists.
    await expect(await AppPage.libraryImportButton).toBeDisabled();
    await expect(await AppPage.libraryFolderButton).toBeDisabled();
  });

  it("shows the empty-state note when the library has no assets", async () => {
    // With nothing imported the body renders a single empty-state paragraph.
    await expect(await AppPage.libraryEmpty).toBeDisplayed();
  });
});
