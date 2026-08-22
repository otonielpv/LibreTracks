import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DiagnosticsSettingsTab } from "./DiagnosticsSettingsTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

const readDiagnosticsLog = vi.fn();
const saveDiagnosticsLog = vi.fn();

vi.mock("@libretracks/shared/desktopApi", () => ({
  isAndroidApp: false,
  readErrorLog: vi.fn(async () => ""),
  revealErrorLog: vi.fn(async () => {}),
  readDiagnosticsLog: (...args: unknown[]) => readDiagnosticsLog(...args),
  saveDiagnosticsLog: (...args: unknown[]) => saveDiagnosticsLog(...args),
}));

describe("DiagnosticsSettingsTab", () => {
  it("shows the error log inside the app instead of only offering the clipboard", async () => {
    readDiagnosticsLog.mockResolvedValue({
      path: "/data/logs/errors.log",
      totalBytes: 2048,
      truncated: false,
      contents: "[123] frontend: algo se rompio\n",
    });

    render(<DiagnosticsSettingsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: "View log" })[0]);

    await waitFor(() => {
      expect(screen.getByText(/algo se rompio/)).toBeTruthy();
    });
    expect(readDiagnosticsLog).toHaveBeenCalledWith("errors");
    expect(screen.getByText("/data/logs/errors.log")).toBeTruthy();
  });

  it("reads the engine log — the one that records why a track went silent", async () => {
    readDiagnosticsLog.mockResolvedValue({
      path: "/data/logs/lt_audio_debug.log",
      totalBytes: 9_000_000,
      truncated: true,
      contents: "[LT_STARVATION] streaming prebuffer behind\n",
    });

    render(<DiagnosticsSettingsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: "View log" })[1]);

    await waitFor(() => {
      expect(screen.getByText(/LT_STARVATION/)).toBeTruthy();
    });
    expect(readDiagnosticsLog).toHaveBeenCalledWith("engine");
    // A long log is shown from the end, and the view says so.
    expect(screen.getByText(/showing the end of the file/)).toBeTruthy();
  });

  it("offers saving the whole file, which is the only way off an Android device", async () => {
    saveDiagnosticsLog.mockResolvedValue(true);

    render(<DiagnosticsSettingsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: "Save log…" })[1]);

    await waitFor(() => {
      expect(screen.getByText("Log saved.")).toBeTruthy();
    });
    expect(saveDiagnosticsLog).toHaveBeenCalledWith("engine");
  });
});
