import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_VIDEO_STATE, useVideoStore } from "../video/videoStore";
import { VideoSettingsTab } from "./VideoSettingsTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => "C:/imgs/logo.png"),
}));

const api = vi.hoisted(() => ({
  applyVideoOutputSettings: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({ videoOutput: undefined })),
  getVideoMediaStatus: vi.fn(),
  getVideoSyncStats: vi.fn(async () => null),
  identifyVideoDisplays: vi.fn(async () => undefined),
  listVideoDisplays: vi.fn(async () => [
    { number: 1, name: "\\\\.\\DISPLAY1", width: 1920, height: 1080, x: 0, y: 0, isPrimary: true, hasApp: true },
    { number: 2, name: "\\\\.\\DISPLAY2", width: 1280, height: 720, x: 1920, y: 0, isPrimary: false, hasApp: false },
  ]),
  setVideoCalibration: vi.fn(async () => undefined),
  showVideoTestPattern: vi.fn(async () => undefined),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

function available(value: boolean) {
  const status = value
    ? { supportedPlatform: true, available: true, clientApiVersion: "2.5" }
    : { supportedPlatform: true, available: false, reason: "libmpv-2.dll no encontrada" };
  api.getVideoMediaStatus.mockResolvedValue(status);
  useVideoStore.setState({ ...INITIAL_VIDEO_STATE, status });
}

function lastApplied() {
  const calls = api.applyVideoOutputSettings.mock.calls as unknown as Array<[Record<string, unknown>]>;
  return calls[calls.length - 1]?.[0];
}

describe("VideoSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    useVideoStore.setState(INITIAL_VIDEO_STATE);
  });

  it("without libmpv explains why and disables every control", async () => {
    available(false);
    render(<VideoSettingsTab />);
    expect(await screen.findByText("transport.video.settings.unavailable")).toBeTruthy();
    for (const control of screen.getAllByRole("combobox")) {
      expect((control as HTMLSelectElement).disabled).toBe(true);
    }
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByText("transport.video.settings.wizard") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("each control applies its own field at once", async () => {
    available(true);
    render(<VideoSettingsTab />);
    await screen.findByText(/1280×720/);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(lastApplied()).toMatchObject({ enabled: true });

    fireEvent.change(screen.getByLabelText("transport.video.settings.display"), {
      target: { value: "\\\\.\\DISPLAY2" },
    });
    expect(lastApplied()).toMatchObject({
      enabled: true,
      display: { name: "\\\\.\\DISPLAY2", width: 1280, height: 720, x: 1920, y: 0 },
    });

    fireEvent.change(screen.getByLabelText("transport.video.settings.fit"), {
      target: { value: "cover" },
    });
    expect(lastApplied()).toMatchObject({ fit: "cover", display: { name: "\\\\.\\DISPLAY2" } });

    fireEvent.change(screen.getByLabelText("transport.video.settings.mode"), {
      target: { value: "window" },
    });
    expect(lastApplied()).toMatchObject({ mode: "window" });

    fireEvent.change(screen.getByLabelText("transport.video.settings.whenStopped"), {
      target: { value: "black" },
    });
    expect(lastApplied()).toMatchObject({ whenStopped: "black" });

    fireEvent.change(screen.getByLabelText("transport.video.settings.hwdec"), {
      target: { value: "off" },
    });
    expect(lastApplied()).toMatchObject({ hwdec: "off" });

    fireEvent.change(screen.getByLabelText("transport.video.settings.latencyMs"), {
      target: { value: "9999" },
    });
    expect(lastApplied()).toMatchObject({ latencyOffsetMs: 500 });

    fireEvent.change(screen.getByLabelText("transport.video.settings.idle"), {
      target: { value: "image" },
    });
    await waitFor(() =>
      expect(lastApplied()).toMatchObject({ idle: { kind: "image", path: "C:/imgs/logo.png" } }),
    );
  });

  it("calibration starts with the song's beat grid and ends when the tab closes", async () => {
    available(true);
    api.getSettings.mockResolvedValueOnce({
      videoOutput: { enabled: true } as never,
    });
    const view = render(<VideoSettingsTab />);
    const calibrate = await screen.findByText("transport.video.settings.calibrate");
    await waitFor(() => expect((calibrate as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(calibrate);
    expect(api.setVideoCalibration).toHaveBeenLastCalledWith({ interval: 0.5, firstBeat: 0 });
    expect(screen.getByText("transport.video.settings.calibrationSteps")).toBeTruthy();

    view.unmount();
    expect(api.setVideoCalibration).toHaveBeenLastCalledWith(null);
    expect(api.showVideoTestPattern).toHaveBeenLastCalledWith(false);
  });

  it("the wizard button opens the setup wizard", async () => {
    available(true);
    render(<VideoSettingsTab />);
    fireEvent.click(await screen.findByText("transport.video.settings.wizard"));
    expect(useVideoStore.getState().wizardOpen).toBe(true);
  });
});
