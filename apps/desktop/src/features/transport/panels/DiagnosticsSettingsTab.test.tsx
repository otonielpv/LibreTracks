import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiagnosticsSettingsTab } from "./DiagnosticsSettingsTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

const readDiagnosticsLog = vi.fn();
const saveDiagnosticsLog = vi.fn();
const clearDiagnosticsLog = vi.fn();
const confirmDialog = vi.fn();

vi.mock("@libretracks/shared/desktopApi", () => ({
  isMobileApp: false,
  readErrorLog: vi.fn(async () => ""),
  revealErrorLog: vi.fn(async () => {}),
  readDiagnosticsLog: (...args: unknown[]) => readDiagnosticsLog(...args),
  saveDiagnosticsLog: (...args: unknown[]) => saveDiagnosticsLog(...args),
  clearDiagnosticsLog: (...args: unknown[]) => clearDiagnosticsLog(...args),
}));

vi.mock("../../../shared/dialog/dialogService", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialog(...args),
}));

describe("DiagnosticsSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("deletes the accumulated engine log after confirmation", async () => {
    confirmDialog.mockResolvedValue(true);
    clearDiagnosticsLog.mockResolvedValue(undefined);

    render(<DiagnosticsSettingsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete log" })[1]);

    await waitFor(() => {
      expect(screen.getByText("Audio engine log deleted.")).toBeTruthy();
    });
    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(clearDiagnosticsLog).toHaveBeenCalledWith("engine");
  });

  it("deletes the normal error log independently from the engine log", async () => {
    confirmDialog.mockResolvedValue(true);
    clearDiagnosticsLog.mockResolvedValue(undefined);

    render(<DiagnosticsSettingsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete log" })[0]);

    await waitFor(() => {
      expect(screen.getByText("Error log deleted.")).toBeTruthy();
    });
    expect(clearDiagnosticsLog).toHaveBeenCalledWith("errors");
    expect(clearDiagnosticsLog).not.toHaveBeenCalledWith("engine");
  });

  it("keeps the engine log when deletion is cancelled", async () => {
    confirmDialog.mockResolvedValue(false);

    render(<DiagnosticsSettingsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete log" })[1]);

    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    expect(clearDiagnosticsLog).not.toHaveBeenCalled();
  });

  it("keeps audio performance controls out of the diagnostics tab", () => {
    render(<DiagnosticsSettingsTab />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/single thread/i)).toBeNull();
  });
});
