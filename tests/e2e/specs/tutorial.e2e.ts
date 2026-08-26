import { browser, expect, $, $$ } from "@wdio/globals";
import AppPage from "../pageobjects/app.page.js";

/**
 * The guided tour, driven through the real app.
 *
 * This is the layer jsdom cannot reach. The unit tests prove the step data, the
 * store and the context split; what they cannot prove is that a step actually
 * finds its control on screen and gets a usable rectangle back — jsdom returns
 * all-zero rects for everything, so a spotlight "renders" there even when it is
 * anchored to nothing. Here the geometry is real, and the spotlight is checked
 * against the button it claims to be highlighting.
 *
 * Selectors go through `data-lt-tour` / `data-tour-id`, not aria-labels or
 * visible copy: those are the tour's own contract and, unlike the labels, they
 * do not change with the UI language (this app boots in Spanish on the runner).
 *
 * The tour is exercised from the side-rail button on purpose. Auto-start is
 * suppressed under WebDriver — otherwise it would cover the landing screen and
 * take every other spec down with it — and the first assertion here is that
 * this suppression actually holds.
 *
 * Everything below runs with NO session open, so it covers the landing tour.
 * The work-area tour is the same machinery pointed at controls that only exist
 * once a project is loaded; its step data is covered by the unit tests.
 */
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
    await (await $(".lt-tour-actions button.is-primary")).click();

    const root = await $(".lt-tour-root");
    await expect(root).toHaveAttribute("data-tour-step", "create");

    const spotlight = await $(".lt-tour-spotlight");
    await spotlight.waitForExist({
      timeout: 10_000,
      timeoutMsg:
        "No spotlight on the Create step: the anchor did not resolve to a " +
        "visible element",
    });

    // The cut-out must actually sit over the Create button — a spotlight in the
    // wrong place still "exists", which is exactly the failure jsdom cannot see.
    // The overlay insets the hole by SPOTLIGHT_PADDING (6px) on every side.
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

  it("walks to the end and closes itself", async () => {
    // One dot per step the platform actually sees, so the walk does not hardcode
    // a count that changes whenever a step is added.
    const totalSteps = (await $$(".lt-tour-dots span").getElements()).length;
    expect(totalSteps).toBeGreaterThan(1);

    // The tour is already on step 2 from the previous test.
    for (let remaining = totalSteps - 1; remaining > 0; remaining -= 1) {
      await (await $(".lt-tour-actions button.is-primary")).click();
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
