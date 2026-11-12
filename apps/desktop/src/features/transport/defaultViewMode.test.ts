import { afterEach, describe, expect, it, vi } from "vitest";

import { readStoredDefaultViewMode, storeDefaultViewMode } from "./defaultViewMode";

describe("default view mode preference", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it("falls back when nothing (or garbage) is stored", () => {
    expect(readStoredDefaultViewMode("daw")).toBe("daw");
    window.localStorage.setItem("lt.defaultViewMode", "nope");
    expect(readStoredDefaultViewMode("daw")).toBe("daw");
  });

  it("round-trips the chosen view", () => {
    storeDefaultViewMode("live");
    expect(readStoredDefaultViewMode("daw")).toBe("live");
  });

  it("makes the app start in the stored view", async () => {
    storeDefaultViewMode("setlist");
    vi.resetModules();
    const { useTimelineUIStore } = await import("./uiStore");
    expect(useTimelineUIStore.getState().viewMode).toBe("setlist");
  });
});
