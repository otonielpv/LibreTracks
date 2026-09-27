import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_VIDEO_OUTPUT_SETTINGS, type VideoOutputSettings } from "../desktopApi";
import {
  outputIsUnconfigured,
  runFirstVideoClipTrigger,
  runSessionOpenTrigger,
  sessionSetupNotice,
} from "./videoSetupTriggers";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  listVideoDisplays: vi.fn(),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

const DISPLAY2 = { name: "\\\\.\\DISPLAY2", width: 1280, height: 720, x: 1920, y: 0 };
const configured: VideoOutputSettings = { ...DEFAULT_VIDEO_OUTPUT_SETTINGS, enabled: true, display: DISPLAY2 };
const monitors = [
  { ...DISPLAY2, name: "\\\\.\\DISPLAY1", x: 0, number: 1, isPrimary: true, hasApp: true },
  { ...DISPLAY2, number: 2, isPrimary: false, hasApp: false },
];

function libmpv(available: boolean) {
  useVideoStore.setState({ status: { supportedPlatform: true, available } });
}

beforeEach(() => {
  vi.clearAllMocks();
  useVideoStore.setState(INITIAL_VIDEO_STATE);
});

describe("sessionSetupNotice", () => {
  const base = {
    sessionKey: "s1",
    songHasVideo: true,
    settings: configured,
    displays: monitors,
    dismissedSessions: [] as string[],
  };

  it("says nothing without video, when dismissed, or when the display is there", () => {
    expect(sessionSetupNotice({ ...base, songHasVideo: false, settings: DEFAULT_VIDEO_OUTPUT_SETTINGS })).toBeNull();
    expect(
      sessionSetupNotice({ ...base, settings: DEFAULT_VIDEO_OUTPUT_SETTINGS, dismissedSessions: ["s1"] }),
    ).toBeNull();
    expect(sessionSetupNotice(base)).toBeNull();
  });

  it("offers to configure when there is no output set up", () => {
    expect(sessionSetupNotice({ ...base, settings: DEFAULT_VIDEO_OUTPUT_SETTINGS })).toEqual({
      kind: "configure",
      sessionKey: "s1",
    });
    expect(sessionSetupNotice({ ...base, settings: { ...configured, enabled: false } })?.kind).toBe("configure");
  });

  it("names the configured display when it is not connected", () => {
    expect(sessionSetupNotice({ ...base, displays: [monitors[0]] })).toEqual({
      kind: "displayMissing",
      sessionKey: "s1",
      displayName: "DISPLAY2",
    });
  });

  it("a dismissal counts for its own session only", () => {
    const settings = DEFAULT_VIDEO_OUTPUT_SETTINGS;
    expect(sessionSetupNotice({ ...base, settings, sessionKey: "s2", dismissedSessions: ["s1"] })?.kind).toBe(
      "configure",
    );
  });
});

describe("first video clip", () => {
  it("opens the wizard when no display is set up", async () => {
    libmpv(true);
    api.getSettings.mockResolvedValue({ videoOutput: undefined });
    await runFirstVideoClipTrigger();
    expect(useVideoStore.getState().wizardOpen).toBe(true);
    expect(useVideoStore.getState().wizardStep).toBe(0);
  });

  it("does not open it with a display configured", async () => {
    libmpv(true);
    api.getSettings.mockResolvedValue({ videoOutput: configured });
    await runFirstVideoClipTrigger();
    expect(useVideoStore.getState().wizardOpen).toBe(false);
  });

  it("does not open it without libmpv (nothing could be configured)", async () => {
    libmpv(false);
    api.getSettings.mockResolvedValue({ videoOutput: undefined });
    await runFirstVideoClipTrigger();
    expect(useVideoStore.getState().wizardOpen).toBe(false);
  });

  it("an off output with a display counts as unconfigured", () => {
    expect(outputIsUnconfigured({ ...configured, enabled: false })).toBe(true);
    expect(outputIsUnconfigured(configured)).toBe(false);
  });
});

describe("opening a session", () => {
  it("shows 'I can't find the display' when the configured one is unplugged", async () => {
    libmpv(true);
    api.getSettings.mockResolvedValue({ videoOutput: configured });
    api.listVideoDisplays.mockResolvedValue([monitors[0]]);
    await runSessionOpenTrigger("s1", true);
    expect(useVideoStore.getState().setupNotice).toEqual({
      kind: "displayMissing",
      sessionKey: "s1",
      displayName: "DISPLAY2",
    });

    // "Continue without video" is remembered for this session.
    useVideoStore.getState().dismissSetupNotice();
    await runSessionOpenTrigger("s1", true);
    expect(useVideoStore.getState().setupNotice).toBeNull();
  });

  it("shows nothing for a session without video", async () => {
    libmpv(true);
    api.getSettings.mockResolvedValue({ videoOutput: undefined });
    api.listVideoDisplays.mockResolvedValue(monitors);
    await runSessionOpenTrigger("s1", false);
    expect(useVideoStore.getState().setupNotice).toBeNull();
    expect(api.listVideoDisplays).not.toHaveBeenCalled();
  });
});
