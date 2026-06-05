import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReleaseInfo } from "../../shared/updateCheck";

// The store keeps module-level singleton state, so each test loads a fresh
// copy via dynamic import after resetting modules and the mock registry.
const fetchLatestRelease = vi.fn();
const shouldNotify = vi.fn();

vi.mock("../../shared/updateCheck", () => ({
  fetchLatestRelease: (...args: unknown[]) => fetchLatestRelease(...args),
  shouldNotify: (...args: unknown[]) => shouldNotify(...args),
}));

function makeRelease(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    tag: "v2.0.0",
    version: "2.0.0",
    url: "https://example.com/release",
    publishedAt: "2026-01-01T00:00:00Z",
    body: "notes",
    ...overrides,
  };
}

async function loadStore() {
  vi.resetModules();
  return import("./updateCheckStore");
}

beforeEach(() => {
  fetchLatestRelease.mockReset();
  shouldNotify.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("updateCheckStore", () => {
  it("exposes the documented initial snapshot", async () => {
    const store = await loadStore();
    expect(store.getUpdateCheckSnapshot()).toEqual({
      release: null,
      error: null,
      isChecking: false,
      isModalOpen: false,
      hasCheckedOnce: false,
    });
  });

  it("stores and reads the current version", async () => {
    const store = await loadStore();
    store.setCurrentVersion("1.2.3");
    expect(store.getCurrentVersion()).toBe("1.2.3");
  });

  it("does nothing when no current version is set", async () => {
    const store = await loadStore();
    await store.runUpdateCheck();
    expect(fetchLatestRelease).not.toHaveBeenCalled();
    expect(store.getUpdateCheckSnapshot().isChecking).toBe(false);
  });

  it("records a checked-but-no-release state when fetch returns null", async () => {
    const store = await loadStore();
    store.setCurrentVersion("1.0.0");
    fetchLatestRelease.mockResolvedValue(null);
    await store.runUpdateCheck();
    const snap = store.getUpdateCheckSnapshot();
    expect(snap.release).toBeNull();
    expect(snap.hasCheckedOnce).toBe(true);
    expect(snap.isChecking).toBe(false);
  });

  it("opens the modal when shouldNotify is true", async () => {
    const store = await loadStore();
    store.setCurrentVersion("1.0.0");
    const release = makeRelease();
    fetchLatestRelease.mockResolvedValue(release);
    shouldNotify.mockReturnValue(true);
    await store.runUpdateCheck();
    const snap = store.getUpdateCheckSnapshot();
    expect(snap.release).toBe(release);
    expect(snap.isModalOpen).toBe(true);
    expect(snap.hasCheckedOnce).toBe(true);
  });

  it("keeps the modal closed when shouldNotify is false", async () => {
    const store = await loadStore();
    store.setCurrentVersion("1.0.0");
    fetchLatestRelease.mockResolvedValue(makeRelease());
    shouldNotify.mockReturnValue(false);
    await store.runUpdateCheck();
    expect(store.getUpdateCheckSnapshot().isModalOpen).toBe(false);
  });

  it("forwards the force flag to bypass snooze", async () => {
    const store = await loadStore();
    store.setCurrentVersion("1.0.0");
    fetchLatestRelease.mockResolvedValue(makeRelease());
    shouldNotify.mockReturnValue(true);
    await store.runUpdateCheck({ force: true });
    expect(shouldNotify).toHaveBeenCalledWith(
      expect.objectContaining({ bypassSnooze: true }),
    );
  });

  it("captures an error message when the fetch throws", async () => {
    const store = await loadStore();
    store.setCurrentVersion("1.0.0");
    fetchLatestRelease.mockRejectedValue(new Error("network down"));
    await store.runUpdateCheck();
    const snap = store.getUpdateCheckSnapshot();
    expect(snap.error).toBe("network down");
    expect(snap.hasCheckedOnce).toBe(true);
    expect(snap.isChecking).toBe(false);
  });

  it("openUpdateModal only opens when a release is present", async () => {
    const store = await loadStore();
    store.openUpdateModal();
    expect(store.getUpdateCheckSnapshot().isModalOpen).toBe(false);

    store.setCurrentVersion("1.0.0");
    fetchLatestRelease.mockResolvedValue(makeRelease());
    shouldNotify.mockReturnValue(false);
    await store.runUpdateCheck();
    store.openUpdateModal();
    expect(store.getUpdateCheckSnapshot().isModalOpen).toBe(true);
  });

  it("closeUpdateModal closes an open modal", async () => {
    const store = await loadStore();
    store.setCurrentVersion("1.0.0");
    fetchLatestRelease.mockResolvedValue(makeRelease());
    shouldNotify.mockReturnValue(true);
    await store.runUpdateCheck();
    expect(store.getUpdateCheckSnapshot().isModalOpen).toBe(true);
    store.closeUpdateModal();
    expect(store.getUpdateCheckSnapshot().isModalOpen).toBe(false);
  });

  it("marks isChecking while a check is in flight and clears it after", async () => {
    const store = await loadStore();
    store.setCurrentVersion("1.0.0");
    let resolveFetch: (value: ReleaseInfo | null) => void = () => {};
    fetchLatestRelease.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    shouldNotify.mockReturnValue(false);

    const pending = store.runUpdateCheck();
    expect(store.getUpdateCheckSnapshot().isChecking).toBe(true);
    resolveFetch(makeRelease());
    await pending;
    expect(store.getUpdateCheckSnapshot().isChecking).toBe(false);
  });

  it("passes an abort signal to fetchLatestRelease", async () => {
    const store = await loadStore();
    store.setCurrentVersion("1.0.0");
    fetchLatestRelease.mockResolvedValue(null);
    await store.runUpdateCheck();
    expect(fetchLatestRelease).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
