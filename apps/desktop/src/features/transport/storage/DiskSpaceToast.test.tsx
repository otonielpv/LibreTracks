import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DiskSpaceLowNotice } from "../desktopApi";
import { DiskSpaceToast, formatDiskSize } from "./DiskSpaceToast";

let emit: ((notice: DiskSpaceLowNotice) => void) | null = null;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      `${key} ${JSON.stringify(options ?? {})}`,
    i18n: { language: "es" },
  }),
}));

vi.mock("../desktopApi", () => ({
  listenToDiskSpaceLow: async (handler: (notice: DiskSpaceLowNotice) => void) => {
    emit = handler;
    return () => {
      emit = null;
    };
  },
}));

describe("DiskSpaceToast", () => {
  it("stays silent until the backend reports a shortfall, then explains it", async () => {
    render(<DiskSpaceToast />);
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      await Promise.resolve();
    });
    act(() => emit?.({ failedSources: 3, neededMb: 4400, freeMb: 900 }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("diskSpace.low");
    expect(alert.textContent).toContain('"count":3');
    expect(alert.textContent).toContain('"needed":"4,3 GB"');
    expect(alert.textContent).toContain('"free":"900 MB"');

    // It does not go away on its own; only when the user closes it.
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("formatDiskSize", () => {
  it("reads in MB below a gigabyte and in GB above", () => {
    expect(formatDiskSize(850, "es")).toBe("850 MB");
    expect(formatDiskSize(4400, "es")).toBe("4,3 GB");
    expect(formatDiskSize(4400, "en")).toBe("4.3 GB");
  });
});
