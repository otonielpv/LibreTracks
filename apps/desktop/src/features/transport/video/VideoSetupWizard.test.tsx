import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_VIDEO_OUTPUT_SETTINGS } from "../desktopApi";
import { VideoSetupLayer } from "./VideoSetupLayer";
import { DISPLAY_POLL_MS, fitPreviewRect, VideoSetupWizard } from "./VideoSetupWizard";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

const DISPLAY1 = { number: 1, name: "\\\\.\\DISPLAY1", width: 1920, height: 1080, x: 0, y: 0, isPrimary: true, hasApp: true };
const DISPLAY2 = { number: 2, name: "\\\\.\\DISPLAY2", width: 1280, height: 720, x: 1920, y: 0, isPrimary: false, hasApp: false };
const ORIGINAL = { ...DEFAULT_VIDEO_OUTPUT_SETTINGS, latencyOffsetMs: 40 };

const api = vi.hoisted(() => ({
  applyVideoOutputSettings: vi.fn(async () => undefined),
  getSettings: vi.fn(),
  identifyVideoDisplays: vi.fn(async () => undefined),
  listVideoDisplays: vi.fn(),
  setVideoCalibration: vi.fn(async () => undefined),
  showVideoTestPattern: vi.fn(async () => undefined),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

function openWizard(step = 0) {
  useVideoStore.setState({
    ...INITIAL_VIDEO_STATE,
    status: { supportedPlatform: true, available: true, clientApiVersion: "2.5" },
  });
  useVideoStore.getState().openWizard(step);
}

const next = () => fireEvent.click(screen.getByText("transport.video.wizard.next"));
const applied = () => api.applyVideoOutputSettings.mock.calls as unknown as Array<[Record<string, unknown>]>;

describe("VideoSetupWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSettings.mockResolvedValue({ videoOutput: ORIGINAL });
    api.listVideoDisplays.mockResolvedValue([DISPLAY1, DISPLAY2]);
  });
  afterEach(() => {
    vi.useRealTimers();
    useVideoStore.setState(INITIAL_VIDEO_STATE);
  });

  it("goes through every step and applies the choices only on Done", async () => {
    openWizard();
    render(<VideoSetupWizard />);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    next();
    expect(await screen.findByText("DISPLAY2")).toBeTruthy();
    expect(api.identifyVideoDisplays).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("DISPLAY2"));
    expect(applied()).toHaveLength(0);

    next();
    // Check: the pattern is projected on the chosen display (a preview).
    expect(api.showVideoTestPattern).toHaveBeenLastCalledWith(true);
    expect(applied()[0][0]).toMatchObject({ enabled: true, display: { name: DISPLAY2.name }, mode: "fullscreen" });
    fireEvent.click(screen.getByText("transport.video.wizard.check.yes"));
    expect(api.showVideoTestPattern).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByText("transport.video.menu.fitCover"));
    next();
    fireEvent.click(screen.getByText("transport.video.wizard.sync.skip"));
    fireEvent.click(screen.getByText("transport.video.wizard.finish"));

    expect(applied().at(-1)?.[0]).toMatchObject({
      enabled: true,
      display: { name: DISPLAY2.name },
      fit: "cover",
      latencyOffsetMs: 40,
    });
    expect(useVideoStore.getState().wizardOpen).toBe(false);
  });

  it("cancelling before anything was previewed applies nothing", async () => {
    openWizard();
    render(<VideoSetupWizard />);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    next();
    fireEvent.click(await screen.findByText("DISPLAY2"));
    fireEvent.click(screen.getByText("transport.video.wizard.cancel", { selector: "footer button" }));
    expect(applied()).toHaveLength(0);
    expect(useVideoStore.getState().wizardOpen).toBe(false);
  });

  it("cancelling after the check step puts the original settings back", async () => {
    openWizard();
    render(<VideoSetupWizard />);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    next();
    fireEvent.click(await screen.findByText("DISPLAY2"));
    next();
    expect(applied()).toHaveLength(1);
    fireEvent.click(screen.getByText("transport.video.wizard.cancel", { selector: "footer button" }));
    expect(applied().at(-1)?.[0]).toEqual(ORIGINAL);
    expect(api.showVideoTestPattern).toHaveBeenLastCalledWith(false);
  });

  it("with one monitor offers a window, and a second monitor appears without closing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.listVideoDisplays.mockResolvedValue([DISPLAY1]);
    openWizard(1);
    render(<VideoSetupWizard />);
    expect(await screen.findByText("transport.video.wizard.display.oneMonitor")).toBeTruthy();
    fireEvent.click(screen.getByText("transport.video.wizard.display.useWindow"));

    // The projector is plugged in: the next poll lists it.
    api.listVideoDisplays.mockResolvedValue([DISPLAY1, DISPLAY2]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISPLAY_POLL_MS);
    });
    expect(screen.getByText("DISPLAY2")).toBeTruthy();
    expect(screen.queryByText("transport.video.wizard.display.oneMonitor")).toBeNull();
    expect(useVideoStore.getState().wizardOpen).toBe(true);

    // The window choice made meanwhile is kept.
    next();
    expect(applied()[0][0]).toMatchObject({ display: { name: DISPLAY1.name }, mode: "window" });
  });

  it("without libmpv the welcome step says why and cannot go on", async () => {
    useVideoStore.setState({
      ...INITIAL_VIDEO_STATE,
      status: { supportedPlatform: true, available: false, reason: "falta libmpv-2.dll" },
    });
    useVideoStore.getState().openWizard();
    render(<VideoSetupWizard />);
    expect(screen.getByText("transport.video.settings.unavailable")).toBeTruthy();
    expect((screen.getByText("transport.video.wizard.next") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("VideoSetupNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSettings.mockResolvedValue({ videoOutput: ORIGINAL });
    api.listVideoDisplays.mockResolvedValue([DISPLAY1]);
  });
  afterEach(() => useVideoStore.setState(INITIAL_VIDEO_STATE));

  it("'Choose another' opens the wizard on the display step", async () => {
    openWizard();
    useVideoStore.setState({
      wizardOpen: false,
      setupNotice: { kind: "displayMissing", sessionKey: "s1", displayName: "DISPLAY2" },
    });
    render(<VideoSetupLayer />);
    fireEvent.click(screen.getByText("transport.video.notice.chooseOther"));
    expect(useVideoStore.getState().wizardOpen).toBe(true);
    expect(await screen.findByText("transport.video.wizard.display.title")).toBeTruthy();
    expect(screen.queryByText("transport.video.notice.chooseOther")).toBeNull();
  });

  it("'Continue without video' hides it for this session", () => {
    useVideoStore.setState({
      ...INITIAL_VIDEO_STATE,
      setupNotice: { kind: "displayMissing", sessionKey: "s1", displayName: "DISPLAY2" },
    });
    render(<VideoSetupLayer />);
    fireEvent.click(screen.getByText("transport.video.notice.continueWithout"));
    expect(screen.queryByText("transport.video.notice.displayMissing")).toBeNull();
    expect(useVideoStore.getState().dismissedSetupSessions).toEqual(["s1"]);
  });
});

describe("fitPreviewRect", () => {
  it("contain letterboxes, cover crops, stretch fills", () => {
    // 4:3 video on a 16:9 monitor, 160 px wide frame (90 px high).
    expect(fitPreviewRect("contain", 16 / 9, 4 / 3, 160)).toEqual({ width: 120, height: 90 });
    expect(fitPreviewRect("cover", 16 / 9, 4 / 3, 160)).toEqual({ width: 160, height: 120 });
    expect(fitPreviewRect("stretch", 16 / 9, 4 / 3, 160)).toEqual({ width: 160, height: 90 });
  });
});
