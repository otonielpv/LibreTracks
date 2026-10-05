import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_VIDEO_STATE, useVideoStore } from "../video/videoStore";
import { VideoSettingsTab } from "./VideoSettingsTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

/** Plan video-mobile, paso 10: the platform is switched per test. */
const platform = vi.hoisted(() => ({ ios: false }));

const api = vi.hoisted(() => ({
  applyVideoOutputSettings: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({ videoOutput: undefined })),
  getVideoMediaStatus: vi.fn(async () => ({ supportedPlatform: true, available: true })),
  getVideoSyncStats: vi.fn(async () => null),
  identifyVideoDisplays: vi.fn(async () => undefined),
  listVideoDisplays: vi.fn(async () => [
    { number: 1, name: "HDMI", width: 1920, height: 1080, x: 0, y: 0, isPrimary: false, hasApp: false },
  ]),
  listenToVideoDisplays: vi.fn(async () => () => {}),
  setVideoCalibration: vi.fn(async () => undefined),
  showVideoTestPattern: vi.fn(async () => undefined),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
  isMobileApp: true,
  get isIOSApp() {
    return platform.ios;
  },
}));

function lastApplied() {
  const calls = api.applyVideoOutputSettings.mock.calls as unknown as Array<[Record<string, unknown>]>;
  return calls[calls.length - 1]?.[0];
}

describe("VideoSettingsTab on a phone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.ios = false;
    useVideoStore.setState({
      ...INITIAL_VIDEO_STATE,
      status: { supportedPlatform: true, available: true, reason: null, libraryPath: null, clientApiVersion: null },
    });
  });
  afterEach(() => {
    useVideoStore.setState(INITIAL_VIDEO_STATE);
  });

  it("hides what a phone does not have: window mode, always on top, decoding, identify", async () => {
    render(<VideoSettingsTab />);
    await screen.findByText("transport.video.settings.nativeOk", { exact: false });
    expect(screen.queryByText("transport.video.settings.mode")).toBeNull();
    expect(screen.queryByText("transport.video.settings.onTop")).toBeNull();
    expect(screen.queryByText("transport.video.settings.hwdec")).toBeNull();
    expect(screen.queryByText("transport.video.settings.identify")).toBeNull();
    // What stays: display, fit, idle, when stopped, latency.
    expect(screen.getByText("transport.video.settings.display")).toBeTruthy();
    expect(screen.getByText("transport.video.settings.fit")).toBeTruthy();
    expect(screen.getByText("transport.video.settings.idle")).toBeTruthy();
    expect(screen.getByText("transport.video.settings.whenStopped")).toBeTruthy();
    expect(screen.getByText("transport.video.settings.latency")).toBeTruthy();
    // Listens for displays plugged in and out.
    expect(api.listenToVideoDisplays).toHaveBeenCalled();
  });

  it("defaults to the first external display and saves a pinned one like the desktop", async () => {
    render(<VideoSettingsTab />);
    const display = (await screen.findByLabelText("transport.video.settings.display")) as HTMLSelectElement;
    expect(screen.getByText("transport.video.settings.firstExternal")).toBeTruthy();
    await waitFor(() => expect(display.options.length).toBe(2));
    fireEvent.change(display, { target: { value: "HDMI" } });
    expect(lastApplied()?.display).toEqual({ name: "HDMI", width: 1920, height: 1080, x: 0, y: 0 });
    fireEvent.change(display, { target: { value: "" } });
    expect(lastApplied()?.display).toBeNull();
  });

  it("saves the fit and the latency like the desktop", async () => {
    render(<VideoSettingsTab />);
    const fit = (await screen.findByText("transport.video.settings.fit")).parentElement!.querySelector("select")!;
    fireEvent.change(fit, { target: { value: "cover" } });
    expect(lastApplied()?.fit).toBe("cover");
    fireEvent.change(screen.getByLabelText("transport.video.settings.latencyMs"), { target: { value: "120" } });
    expect(lastApplied()?.latencyOffsetMs).toBe(120);
  });

  it("explains the cable for Android", async () => {
    render(<VideoSettingsTab />);
    expect(await screen.findByText("transport.video.settings.mobileHelpAndroid")).toBeTruthy();
    expect(screen.queryByText("transport.video.settings.mobileHelpIos")).toBeNull();
  });

  it("explains the cable and AirPlay for iOS", async () => {
    platform.ios = true;
    render(<VideoSettingsTab />);
    expect(await screen.findByText("transport.video.settings.mobileHelpIos")).toBeTruthy();
    expect(screen.queryByText("transport.video.settings.mobileHelpAndroid")).toBeNull();
  });
});
