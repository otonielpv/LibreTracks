import { browser, expect } from "@wdio/globals";
import AppPage from "../pageobjects/app.page.js";

/**
 * Smoke test for the real, compiled app. Proves the whole native stack is
 * wired end to end: tauri-driver launched the .exe, WebView2 hosted the
 * window, the Vite bundle loaded, and React booted. If this passes, the E2E
 * harness itself is healthy and richer flow specs can build on it.
 */
describe("App launch", () => {
  it("boots the WebView and renders the React app", async () => {
    await AppPage.waitUntilBooted();

    const root = await AppPage.root;
    await expect(root).toBeExisting();

    // The mount point must actually contain rendered markup, not an empty div.
    const rootChildCount = await browser.execute(
      () => document.getElementById("root")?.childElementCount ?? 0,
    );
    expect(rootChildCount).toBeGreaterThan(0);
  });

  it("reports the LibreTracks document title", async () => {
    const title = await browser.getTitle();
    // index.html sets "LibreTracks Desktop"; assert it names the product
    // without pinning the exact string so a title tweak stays green.
    expect(title.toLowerCase()).toContain("libretracks");
  });
});
