import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "libretracks.compactMixer.filterActiveSong";

async function freshStore() {
  vi.resetModules();
  return (await import("./mixerFilterStore")).useMixerFilterStore;
}

describe("mixerFilterStore", () => {
  beforeEach(() => window.localStorage.clear());

  it("starts on for a new user", async () => {
    const store = await freshStore();
    expect(store.getState().filterActiveSong).toBe(true);
  });

  it("keeps a stored 'off' and persists every toggle", async () => {
    window.localStorage.setItem(KEY, "0");
    const store = await freshStore();
    expect(store.getState().filterActiveSong).toBe(false);

    store.getState().toggleFilterActiveSong();
    expect(store.getState().filterActiveSong).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("1");

    store.getState().toggleFilterActiveSong();
    expect(window.localStorage.getItem(KEY)).toBe("0");
  });
});
