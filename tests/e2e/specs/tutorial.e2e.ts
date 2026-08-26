import { browser, expect, $, $$ } from "@wdio/globals";
import AppPage from "../pageobjects/app.page.js";

/**
 * The guided tour, driven through the real app.
 *
 * This is the layer jsdom cannot reach. The unit tests prove the step data, the
 * store, the context split and the wait conditions; what they cannot prove is
 * that a step finds its control on screen and gets a usable rectangle back
 * (jsdom returns all-zero rects, so a spotlight "renders" even when anchored to
 * nothing), nor that a real click actually reaches a control through the hole
 * the shield opens for it.
 *
 * Selectors go through `data-lt-tour` / `data-tour-*`, not aria-labels or
 * visible copy: those are the tour's own contract and, unlike the labels, they
 * do not change with the UI language (this app boots in Spanish on the runner).
 *
 * Auto-start is suppressed under WebDriver — otherwise it would cover the
 * landing screen and take every other spec down with it — and the first
 * assertion here is that this suppression holds.
 *
 * Everything below runs with NO session open, so it covers the landing tour.
 * The work-area tour is the same machinery pointed at controls that only exist
 * once a project is loaded; its step data is covered by the unit tests.
 */

/** Clicks the card's main button, whatever it currently says. */
async function advance(): Promise<void> {
  const buttons = await $$(".lt-tour-actions-main button").getElements();
  await buttons[buttons.length - 1].click();
}

/** Walks the tour forward until it reaches `stepId`. */
async function advanceUntil(stepId: string): Promise<void> {
  for (let guard = 0; guard < 20; guard += 1) {
    const current = await (await $(".lt-tour-root")).getAttribute(
      "data-tour-step",
    );
    if (current === stepId) return;
    await advance();
  }
  throw new Error(`The tour never reached the "${stepId}" step`);
}

describe("Guided tour", () => {
  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
  });

  after(async () => {
    await AppPage.resetShell();
  });

  it("does not auto-start under WebDriver", async () => {
    await expect($(".lt-tour-root")).not.toBeExisting();
  });

  it("offers the landing tour while no session is open", async () => {
    const launcher = await $('[data-lt-tour="side-nav-help"]');
    await launcher.waitForClickable({ timeout: 20_000 });
    await launcher.click();

    const root = await $(".lt-tour-root");
    await root.waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "The tour never appeared after clicking the rail button",
    });

    // The whole point of the two-tour split: with nothing open, the tour must
    // be the one about creating and opening sessions — never the work-area one,
    // whose controls do not exist on this screen.
    await expect(root).toHaveAttribute("data-tour-id", "landing");
    await expect(root).toHaveAttribute("data-tour-step", "welcome");

    // Step one has no control to point at, so the card sits centred over a flat
    // dim rather than cutting a hole.
    await expect($(".lt-tour-card.is-centred")).toBeExisting();
    await expect($(".lt-tour-dim")).toBeExisting();
  });

  it("spotlights the real Create button, not an approximation", async () => {
    await advance();

    const root = await $(".lt-tour-root");
    await expect(root).toHaveAttribute("data-tour-step", "create");

    const spotlight = await $(".lt-tour-spotlight");
    await spotlight.waitForExist({
      timeout: 10_000,
      timeoutMsg:
        "No spotlight on the Create step: the anchor did not resolve to a " +
        "visible element",
    });

    // The cut-out must sit over the Create button — a spotlight in the wrong
    // place still "exists", which is exactly the failure jsdom cannot see. The
    // overlay insets the hole by SPOTLIGHT_PADDING (6px) on every side.
    //
    // Measured with no settling wait on purpose: the first spotlight must NOT
    // animate into place. It used to, flying in from the corner over 160ms
    // because the CSS transition also applied to its first paint, and this
    // assertion is what caught it.
    const padding = 6;
    const button = await $('[data-lt-tour="landing-create"]');
    const buttonBox = await button.getLocation();
    const buttonSize = await button.getSize();
    const spotlightBox = await spotlight.getLocation();
    const spotlightSize = await spotlight.getSize();

    expect(Math.abs(spotlightBox.x - (buttonBox.x - padding))).toBeLessThan(2);
    expect(Math.abs(spotlightBox.y - (buttonBox.y - padding))).toBeLessThan(2);
    expect(
      Math.abs(spotlightSize.width - (buttonSize.width + padding * 2)),
    ).toBeLessThan(2);
    expect(
      Math.abs(spotlightSize.height - (buttonSize.height + padding * 2)),
    ).toBeLessThan(2);
  });

  it("lets the user actually open the settings, and moves on by itself", async () => {
    await advanceUntil("openSettings");

    const root = await $(".lt-tour-root");
    await expect(root).toHaveAttribute("data-tour-awaiting", "true");

    // The click has to pass THROUGH the overlay: on an interactive step the
    // shield is split into four bands around the control instead of covering
    // the screen. If that hole were missing this click would hit the shield and
    // the tour would sit here forever.
    await (await $('[data-lt-tour="side-nav-settings"]')).click();

    await browser.waitUntil(
      async () =>
        (await (await $(".lt-tour-root")).getAttribute("data-tour-step")) ===
        "settingsTour",
      {
        timeout: 10_000,
        timeoutMsg:
          "Opening the settings did not advance the tour: either the click " +
          "never reached the button or the wait condition is not observing it",
      },
    );
    await expect($('[data-lt-tour="settings-modal"]')).toBeDisplayed();

    // And closing it again releases the next step, which is the mirror
    // condition (`present: false`).
    await advance();
    await expect(await $(".lt-tour-root")).toHaveAttribute(
      "data-tour-step",
      "closeSettings",
    );
    await (await $('[data-lt-tour="settings-close"]')).click();

    await browser.waitUntil(
      async () =>
        (await (await $(".lt-tour-root")).getAttribute("data-tour-step")) ===
        "next",
      {
        timeout: 10_000,
        timeoutMsg: "Closing the settings did not advance the tour",
      },
    );
  });

  it("walks to the end and closes itself", async () => {
    // One dot per step the platform actually sees, so the walk does not
    // hardcode a count that changes whenever a step is added.
    const totalSteps = (await $$(".lt-tour-dots span").getElements()).length;
    expect(totalSteps).toBeGreaterThan(1);

    for (let guard = 0; guard < totalSteps; guard += 1) {
      if (!(await $(".lt-tour-root").isExisting())) break;
      await advance();
    }

    await $(".lt-tour-root").waitForExist({
      reverse: true,
      timeout: 10_000,
      timeoutMsg: "The tour did not close after its last step",
    });
  });

  it("can be reopened after it has been seen", async () => {
    // Finishing marks the tour as seen, which only suppresses the automatic
    // first-run start — the rail button must still work.
    const launcher = await $('[data-lt-tour="side-nav-help"]');
    await launcher.click();
    await expect($(".lt-tour-card")).toBeDisplayed();
  });

  it("closes on Escape", async () => {
    await browser.keys(["Escape"]);
    await $(".lt-tour-root").waitForExist({
      reverse: true,
      timeout: 10_000,
      timeoutMsg: "Escape did not close the tour",
    });
  });
});
