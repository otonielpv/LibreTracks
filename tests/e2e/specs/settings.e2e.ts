import { expect, $, browser } from "@wdio/globals";
import AppPage from "../pageobjects/app.page.js";

/**
 * The Settings modal opens from the side-nav with no session, audio device, or
 * filesystem access required. It is a role="tablist" of six desktop tabs
 * (audio, general, shortcuts, diagnostics, midi, midiLearn), each with a stable
 * id (lt-settings-tab-<id>) and a matching role="tabpanel"
 * (lt-settings-panel-<id>). This spec verifies the tablist renders, tab
 * switching drives aria-selected and the visible panel, and the "Atajos"
 * (shortcuts) tab renders its real, interactive content.
 *
 * Locators use the tabs' stable ids and aria-selected rather than text, so a
 * label tweak stays green. We wait on concrete selectors instead of polling
 * document.innerText, which — with the service's per-command script injection —
 * balloons into thousands of executeAsyncScript calls.
 */
describe("Settings modal", () => {
  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    await AppPage.openSettings();
  });

  after(async () => {
    // Leave the shell neutral for the next spec.
    await AppPage.resetShell();
  });

  it("renders the desktop settings tabs with Audio selected by default", async () => {
    await expect(await AppPage.settingsTabList).toBeDisplayed();

    for (const id of ["audio", "general", "shortcuts", "diagnostics", "midi", "midiLearn"]) {
      await expect(await AppPage.settingsTab(id)).toBeDisplayed();
    }

    // The modal always opens on the Audio tab (reset in an effect on open).
    await expect(await AppPage.settingsTab("audio")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(await AppPage.settingsPanel("audio")).toBeDisplayed();
  });

  it("switches to the General tab and updates aria-selected + panel", async () => {
    const generalTab = await AppPage.settingsTab("general");
    await generalTab.waitForClickable({ timeout: 15_000 });
    await generalTab.click();

    await expect(generalTab).toHaveAttribute("aria-selected", "true");
    await expect(await AppPage.settingsPanel("general")).toBeDisplayed();

    // Only one panel is mounted at a time — the Audio panel is gone.
    await expect(await AppPage.settingsPanel("audio")).not.toBeExisting();
  });

  describe("Atajos (shortcuts) tab", () => {
    before(async () => {
      const shortcutsTab = await AppPage.settingsTab("shortcuts");
      await shortcutsTab.waitForClickable({ timeout: 15_000 });
      await shortcutsTab.click();
      await (await AppPage.settingsPanel("shortcuts")).waitForDisplayed({
        timeout: 15_000,
      });
    });

    it("lists the registered shortcut actions with their bindings", async () => {
      const rows = await AppPage.shortcutRows.getElements();
      expect(rows.length).toBeGreaterThan(0);

      // The play/pause action is a stable, always-present binding. Its row must
      // render both a label and a <kbd> chord (or an explicit "unbound" note).
      const playRow = await $(
        '.lt-shortcuts-row*=Reproducir / Pausar',
      );
      await expect(playRow).toBeDisplayed();
    });

    it("filters the list live from the search box", async () => {
      const search = await AppPage.shortcutsSearch;
      await expect(search).toBeDisplayed();

      const before = (await AppPage.shortcutRows.getElements()).length;

      // A query that matches only the play/pause label narrows the list.
      await search.setValue("Reproducir / Pausar");
      await browser.waitUntil(
        async () => (await AppPage.shortcutRows.getElements()).length < before,
        {
          timeout: 10_000,
          timeoutMsg: "Shortcut list did not narrow after searching",
        },
      );

      const after = (await AppPage.shortcutRows.getElements()).length;
      expect(after).toBeGreaterThan(0);
      expect(after).toBeLessThan(before);

      // Clearing the box restores the full list. Neither setValue("") nor
      // clearValue() reliably empties a type="search" input in this WebView (the
      // value survives and React's onChange never sees it), so select-all +
      // Backspace, which does emit the input events React listens for.
      await search.click();
      await browser.keys(["Control", "a"]);
      await browser.keys(["Backspace"]);
      await browser.waitUntil(
        async () => (await AppPage.shortcutRows.getElements()).length === before,
        {
          timeout: 10_000,
          timeoutMsg: "Shortcut list did not restore after clearing search",
        },
      );
    });

    it("exposes a reset-all control", async () => {
      // Present and clickable — we don't click it, to avoid mutating the
      // persisted keybinding overrides that outlive this app instance.
      await expect(await AppPage.shortcutsResetAll).toBeClickable();
    });
  });
});
