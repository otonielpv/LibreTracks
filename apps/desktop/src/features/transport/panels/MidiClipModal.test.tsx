import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MidiClipModal } from "./MidiClipModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("MidiClipModal", () => {
  it("previews the live values of a new unsaved MIDI clip", () => {
    const onTest = vi.fn();
    const note = {
      id: "event-1",
      atSeconds: 0,
      channel: null,
      kind: {
        type: "note" as const,
        note: 60,
        velocity: 100,
        durationSeconds: 0.5,
      },
    };

    render(
      <MidiClipModal
        draft={{
          clipId: null,
          trackId: "midi-track-1",
          timelineStartSeconds: 12.5,
          name: "Initial name",
          events: [note],
        }}
        song={null}
        onCancel={vi.fn()}
        onTest={onTest}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("Initial name"), {
      target: { value: "Unsaved edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "transport.midi.testClip" }));

    expect(onTest).toHaveBeenCalledWith({
      clipId: null,
      trackId: "midi-track-1",
      timelineStartSeconds: 12.5,
      name: "Unsaved edit",
      events: [note],
    });
  });
});
