import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS, type AppSettings } from "@libretracks/shared/models";
import { VoiceGuidePopover } from "./VoiceGuidePopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("./PopoverShell", () => ({
  PopoverShell: ({ children }: { children: React.ReactNode }) => children,
}));

function renderPopover(settings: Partial<AppSettings>, onChange = vi.fn()) {
  render(
    <VoiceGuidePopover
      open
      anchorRef={createRef<HTMLButtonElement>()}
      settings={{ ...DEFAULT_APP_SETTINGS, voiceGuideEnabled: true, ...settings }}
      routeOptions={[]}
      onClose={vi.fn()}
      onChange={onChange}
      onVolumeDraftChange={vi.fn()}
      onCommitVolume={vi.fn()}
    />,
  );
  return onChange;
}

const styleSelect = () =>
  screen.getByRole("combobox", {
    name: "transport.settingsModal.voiceGuideCountStyle",
  }) as HTMLSelectElement;

describe("VoiceGuidePopover count style", () => {
  it("defaults to the plain 1-2-3-4 count", () => {
    renderPopover({});
    expect(styleSelect().value).toBe("full");
    expect(
      Array.from(styleSelect().options).map((option) => option.value),
    ).toEqual(["full", "halfThenFull", "halfTime"]);
  });

  it("sends the chosen style as a settings patch", () => {
    const onChange = renderPopover({});
    fireEvent.change(styleSelect(), { target: { value: "halfThenFull" } });
    expect(onChange).toHaveBeenCalledWith({ voiceGuideCountStyle: "halfThenFull" });
  });

  it("is disabled while the count-in is off (the style would change nothing)", () => {
    renderPopover({ voiceGuideCountInEnabled: false });
    expect(styleSelect().disabled).toBe(true);
  });
});

describe("VoiceGuidePopover only on jumps", () => {
  it("sends the toggle as a settings patch", () => {
    const onChange = renderPopover({});
    fireEvent.click(screen.getByLabelText("transport.settingsModal.voiceGuideJumpsOnly"));
    expect(onChange).toHaveBeenCalledWith({ voiceGuideJumpsOnly: true });
  });

  it("counts the songs without a guide track and reopens the prompt", async () => {
    const { useSongStore } = await import("../songStore");
    const { useGuideTrackPromptStore } = await import("../voiceGuide/guideTrackPrompt");
    useSongStore.setState({
      song: {
        regions: [
          { id: "r1", hasGuideTrack: false },
          { id: "r2", hasGuideTrack: true },
        ],
      } as never,
    });
    useGuideTrackPromptStore.setState({ dismissed: ["r1"], forced: false });
    renderPopover({ voiceGuideJumpsOnly: true });
    expect(screen.getByText("transport.settingsModal.voiceGuideMissingGuide")).toBeTruthy();
    fireEvent.click(screen.getByText("transport.settingsModal.voiceGuideMissingGuideChoose"));
    expect(useGuideTrackPromptStore.getState()).toMatchObject({ dismissed: [], forced: true });
    useSongStore.setState({ song: null });
  });
});
