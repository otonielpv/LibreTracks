import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MIN_ACTIVE_DAYS,
  MIN_MOMENTS,
  REQUEST_INTERVAL_DAYS,
  STORE_REVIEW_STORAGE_KEY,
  isEligible,
  noteStoreReviewMoment,
  readStoreReviewState,
  resetStoreReviewRunState,
  type StoreReviewState,
} from "./storeReview";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 25, 12).getTime();

function memoryStorage(initial?: StoreReviewState) {
  const data = new Map<string, string>();
  if (initial) data.set(STORE_REVIEW_STORAGE_KEY, JSON.stringify(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const veteran: StoreReviewState = {
  activeDays: ["2026-11-20", "2026-11-22", "2026-11-23"],
  moments: MIN_MOMENTS,
  lastRequestAt: null,
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    isStoreBuild: () => true,
    now: () => NOW,
    wait: async () => undefined,
    isTransportQuiet: () => true,
    request: vi.fn(async () => "requested" as const),
    storage: memoryStorage(veteran),
    ...overrides,
  };
}

describe("storeReview", () => {
  beforeEach(() => resetStoreReviewRunState());

  it("never asks while the transport is playing", async () => {
    const d = deps({ isTransportQuiet: () => false });
    await expect(noteStoreReviewMoment("audioAdded", d)).resolves.toBe("audioActive");
    expect(d.request).not.toHaveBeenCalled();
    expect(readStoreReviewState(d.storage).lastRequestAt).toBeNull();
  });

  it("re-checks the transport after the settle delay", async () => {
    let playing = false;
    const d = deps({
      wait: async () => {
        playing = true; // Play pressed during the wait.
      },
      isTransportQuiet: () => !playing,
    });
    await noteStoreReviewMoment("sessionOpened", d);
    expect(d.request).not.toHaveBeenCalled();
  });

  it("does not record a request the backend refused for audio", async () => {
    const d = deps({ request: vi.fn(async () => "audioActive" as const) });
    await expect(noteStoreReviewMoment("audioAdded", d)).resolves.toBe("audioActive");
    expect(readStoreReviewState(d.storage).lastRequestAt).toBeNull();
    // ...and tries again at the next moment.
    await noteStoreReviewMoment("audioAdded", d);
    expect(d.request).toHaveBeenCalledTimes(2);
  });

  it("asks a qualified user once per run and records it", async () => {
    const d = deps();
    await expect(noteStoreReviewMoment("projectSaved", d)).resolves.toBe("requested");
    await noteStoreReviewMoment("projectSaved", d);
    expect(d.request).toHaveBeenCalledTimes(1);
    expect(readStoreReviewState(d.storage).lastRequestAt).toBe(NOW);
  });

  it("does nothing on desktop builds", async () => {
    const d = deps({ isStoreBuild: () => false });
    await expect(noteStoreReviewMoment("audioAdded", d)).resolves.toBe("skipped");
    expect(d.request).not.toHaveBeenCalled();
  });

  it("counts days and moments before qualifying", async () => {
    const d = deps({ storage: memoryStorage() });
    await noteStoreReviewMoment("audioAdded", d);
    const state = readStoreReviewState(d.storage);
    expect(state).toMatchObject({ activeDays: ["2026-11-25"], moments: 1 });
    expect(d.request).not.toHaveBeenCalled();
  });

  it("eligibility needs days, moments and the interval", () => {
    expect(isEligible(veteran, NOW)).toBe(true);
    expect(isEligible({ ...veteran, activeDays: veteran.activeDays.slice(0, MIN_ACTIVE_DAYS - 1) }, NOW)).toBe(false);
    expect(isEligible({ ...veteran, moments: MIN_MOMENTS - 1 }, NOW)).toBe(false);
    expect(isEligible({ ...veteran, lastRequestAt: NOW - (REQUEST_INTERVAL_DAYS - 1) * DAY }, NOW)).toBe(false);
    expect(isEligible({ ...veteran, lastRequestAt: NOW - REQUEST_INTERVAL_DAYS * DAY }, NOW)).toBe(true);
  });
});
