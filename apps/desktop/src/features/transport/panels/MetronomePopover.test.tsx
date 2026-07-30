import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS } from "@libretracks/shared/models";
import { MetronomePopover } from "./MetronomePopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("./PopoverShell", () => ({
  PopoverShell: ({ children }: { children: React.ReactNode }) => children,
}));

describe("MetronomePopover", () => {
  it("allows disabling the accented click", () => {
    const onSoundChange = vi.fn();

    render(
      <MetronomePopover
        open
        anchorRef={createRef<HTMLButtonElement>()}
        settings={{ ...DEFAULT_APP_SETTINGS, metronomeAccentEnabled: true }}
        routeOptions={[]}
        volumeDraft={1}
        midiLearnMode={null}
        onClose={vi.fn()}
        onEnabledChange={vi.fn()}
        onOutputChange={vi.fn()}
        onVolumeDraftChange={vi.fn()}
        onCommitVolume={vi.fn()}
        onSoundChange={onSoundChange}
        onMidiLearnTarget={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Accent enabled" }));

    expect(onSoundChange).toHaveBeenCalledWith({
      metronomeAccentEnabled: false,
    });
  });
});
