import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUpdateCheck } from "./useUpdateCheck";

const setCurrentVersion = vi.fn();
const runUpdateCheck = vi.fn();
const closeUpdateModal = vi.fn();
const shouldRunAutoCheck = vi.fn();

const snapshot = {
  release: null,
  error: null,
  isChecking: false,
  isModalOpen: false,
  hasCheckedOnce: false,
};

vi.mock("../../shared/updateCheck", () => ({
  shouldRunAutoCheck: () => shouldRunAutoCheck(),
}));

vi.mock("./updateCheckStore", () => ({
  setCurrentVersion: (...args: unknown[]) => setCurrentVersion(...args),
  runUpdateCheck: (...args: unknown[]) => runUpdateCheck(...args),
  closeUpdateModal: (...args: unknown[]) => closeUpdateModal(...args),
  useUpdateCheckStore: () => snapshot,
}));

beforeEach(() => {
  setCurrentVersion.mockReset();
  runUpdateCheck.mockReset();
  closeUpdateModal.mockReset();
  shouldRunAutoCheck.mockReset();
  shouldRunAutoCheck.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useUpdateCheck", () => {
  it("registers the current version and runs the auto-check by default", () => {
    renderHook(() => useUpdateCheck({ currentVersion: "1.2.3" }));
    expect(setCurrentVersion).toHaveBeenCalledWith("1.2.3");
    expect(runUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it("does not auto-check when disabled", () => {
    renderHook(() =>
      useUpdateCheck({ currentVersion: "1.2.3", enabled: false }),
    );
    // Version still registered, but no fetch fired.
    expect(setCurrentVersion).toHaveBeenCalledWith("1.2.3");
    expect(runUpdateCheck).not.toHaveBeenCalled();
  });

  it("does not auto-check without a version", () => {
    renderHook(() => useUpdateCheck({ currentVersion: "" }));
    expect(runUpdateCheck).not.toHaveBeenCalled();
  });

  it("respects shouldRunAutoCheck gating (e.g. session snooze)", () => {
    shouldRunAutoCheck.mockReturnValue(false);
    renderHook(() => useUpdateCheck({ currentVersion: "1.2.3" }));
    expect(runUpdateCheck).not.toHaveBeenCalled();
  });

  it("exposes the store snapshot plus a dismiss handler", () => {
    const { result } = renderHook(() =>
      useUpdateCheck({ currentVersion: "1.2.3" }),
    );
    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.hasCheckedOnce).toBe(false);
    result.current.dismiss();
    expect(closeUpdateModal).toHaveBeenCalledTimes(1);
  });

  it("re-registers the version when it changes", () => {
    const { rerender } = renderHook(
      ({ version }) => useUpdateCheck({ currentVersion: version }),
      { initialProps: { version: "1.0.0" } },
    );
    expect(setCurrentVersion).toHaveBeenCalledWith("1.0.0");
    rerender({ version: "2.0.0" });
    expect(setCurrentVersion).toHaveBeenCalledWith("2.0.0");
  });
});
