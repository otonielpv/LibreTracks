import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { askVideoAudioExtraction, decideVideoAudioExtraction } from "./videoAudioExtraction";
import { VideoAudioPrompt } from "./VideoAudioPrompt";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(async (settings: unknown) => settings),
}));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useVideoStore.setState(INITIAL_VIDEO_STATE);
});

describe("decideVideoAudioExtraction", () => {
  it("uses the remembered choice without asking", async () => {
    const ask = vi.fn();
    api.getSettings.mockResolvedValueOnce({ videoAudioOnImport: "extract" });
    expect(await decideVideoAudioExtraction(2, ask)).toBe(true);
    api.getSettings.mockResolvedValueOnce({ videoAudioOnImport: "skip" });
    expect(await decideVideoAudioExtraction(2, ask)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks when nothing is remembered, and remembers only when told to", async () => {
    api.getSettings.mockResolvedValue({ locale: "es" });
    expect(await decideVideoAudioExtraction(1, async () => ({ extract: true, remember: false }))).toBe(true);
    expect(api.saveSettings).not.toHaveBeenCalled();

    expect(await decideVideoAudioExtraction(1, async () => ({ extract: false, remember: true }))).toBe(false);
    expect(api.saveSettings).toHaveBeenCalledWith({ locale: "es", videoAudioOnImport: "skip" });
  });
});

describe("VideoAudioPrompt", () => {
  it("answers with the button pressed and the remember box", async () => {
    render(<VideoAudioPrompt />);
    const answer = askVideoAudioExtraction(1);
    expect(await screen.findByText("transport.video.audio.promptTitle")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("transport.video.audio.extract"));
    expect(await answer).toEqual({ extract: true, remember: true });
    expect(useVideoStore.getState().audioPrompt).toBeNull();
    expect(screen.queryByText("transport.video.audio.promptTitle")).toBeNull();
  });
});
