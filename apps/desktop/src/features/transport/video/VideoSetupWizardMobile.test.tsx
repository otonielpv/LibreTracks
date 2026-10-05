import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type DisplaysHandler = (displays: Array<Record<string, unknown>>) => void;

const api = vi.hoisted(() => ({
  handler: null as DisplaysHandler | null,
  applyVideoOutputSettings: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({ videoOutput: { enabled: false } })),
  listVideoDisplays: vi.fn(async () => []),
  showVideoTestPattern: vi.fn(async () => undefined),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isMobileApp: true,
  isIOSApp: false,
  applyVideoOutputSettings: api.applyVideoOutputSettings,
  getSettings: api.getSettings,
  listVideoDisplays: api.listVideoDisplays,
  showVideoTestPattern: api.showVideoTestPattern,
  listenToVideoDisplays: vi.fn(async (handler: DisplaysHandler) => {
    api.handler = handler;
    return () => {
      api.handler = null;
    };
  }),
}));

import { MOBILE_DISPLAY_HELP_MS, VideoSetupWizardMobile } from "./VideoSetupWizardMobile";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

const hdmi = { number: 1, name: "HDMI", width: 1920, height: 1080, x: 0, y: 0, isPrimary: false, hasApp: false };

async function openWizard() {
  useVideoStore.getState().openWizard();
  render(<VideoSetupWizardMobile />);
  // Let the mount effects' promises settle (settings, list, listener).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Plan video-mobile, paso 10 C2, with vitest's fake timers. */
describe("the phone's video setup wizard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.handler = null;
    useVideoStore.setState(INITIAL_VIDEO_STATE);
  });
  afterEach(() => {
    vi.useRealTimers();
    useVideoStore.setState(INITIAL_VIDEO_STATE);
  });

  it("switches the output on and waits for the cable", async () => {
    await openWizard();
    expect(screen.getByText("transport.video.wizard.mobile.connectTitle")).toBeTruthy();
    expect(api.applyVideoOutputSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(screen.queryByTestId("video-wizard-help")).toBeNull();
  });

  it("explains what to check when no display shows up in 20 s", async () => {
    await openWizard();
    act(() => {
      vi.advanceTimersByTime(MOBILE_DISPLAY_HELP_MS - 1);
    });
    expect(screen.queryByTestId("video-wizard-help")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("video-wizard-help").textContent).toContain(
      "transport.video.settings.mobileHelpAndroid",
    );
  });

  it("moves on to the picture when the native side reports a display", async () => {
    await openWizard();
    expect(api.handler).not.toBeNull();
    act(() => api.handler!([hdmi]));
    expect(screen.getByText("transport.video.wizard.mobile.checkTitle")).toBeTruthy();
    expect(api.showVideoTestPattern).toHaveBeenCalledWith(true);
    // The help timer of the first screen is gone.
    act(() => {
      vi.advanceTimersByTime(MOBILE_DISPLAY_HELP_MS * 2);
    });
    expect(screen.queryByTestId("video-wizard-help")).toBeNull();

    fireEvent.click(screen.getByText("transport.video.wizard.mobile.yes"));
    expect(useVideoStore.getState().wizardOpen).toBe(false);
    expect(api.showVideoTestPattern).toHaveBeenLastCalledWith(false);
  });

  it("cancelling puts the output back as it was", async () => {
    await openWizard();
    fireEvent.click(screen.getByText("transport.video.wizard.cancel"));
    expect(api.applyVideoOutputSettings).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(useVideoStore.getState().wizardOpen).toBe(false);
  });
});
