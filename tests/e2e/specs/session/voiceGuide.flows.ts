import { browser, expect, $ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";

/**
 * The voice guide announces sections/count-ins over the timeline. Its speech is
 * system-TTS dependent, so this asserts the real state round trip rather than the
 * audio: toggling the "Voz guía" split-button flips settings.voiceGuideEnabled
 * (read back from the backend) and the button's is-active class, then restores it.
 *
 * Runs on the shared open session; leaves the voice guide disabled afterwards.
 */
export function registerSessionVoiceGuideFlows() {
  it("toggles the voice guide and round-trips the setting", async () => {
    const before = (await AppPage.settings()).voiceGuideEnabled;

    const button = await $('button[aria-label="Voz guia"]');
    await button.waitForClickable({ timeout: 15_000 });
    await button.click();

    await browser.waitUntil(
      async () => (await AppPage.settings()).voiceGuideEnabled === !before,
      {
        timeout: 30_000,
        timeoutMsg: "Toggling the voice guide never reached the backend settings",
      },
    );

    // The button reflects the enabled state with is-active.
    if (!before) {
      await expect(await $('button[aria-label="Voz guia"]')).toHaveElementClass(
        "is-active",
      );
    }

    // Restore the original state so later flows are unaffected.
    await button.click();
    await browser.waitUntil(
      async () => (await AppPage.settings()).voiceGuideEnabled === before,
      {
        timeout: 30_000,
        timeoutMsg: "The voice guide setting did not restore",
      },
    );
  });
}
