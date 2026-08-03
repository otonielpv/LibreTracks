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
    const onCancel = vi.fn();
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

    const { container } = render(
      <MidiClipModal
        draft={{
          clipId: null,
          trackId: "midi-track-1",
          timelineStartSeconds: 12.5,
          name: "Initial name",
          events: [note],
        }}
        song={null}
        onCancel={onCancel}
        onTest={onTest}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("Initial name"), {
      target: { value: "Unsaved edit" },
    });
    const velocity = screen.getByLabelText("transport.midi.velocity");
    fireEvent.change(velocity, { target: { value: "" } });
    expect((velocity as HTMLInputElement).value).toBe("");
    fireEvent.change(velocity, { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "transport.midi.testClip" }));

    expect(onTest).toHaveBeenCalledWith({
      clipId: null,
      trackId: "midi-track-1",
      timelineStartSeconds: 12.5,
      name: "Unsaved edit",
      events: [{ ...note, kind: { ...note.kind, velocity: 123 } }],
    });

    fireEvent.click(container.querySelector(".lt-modal-backdrop") as Element);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
