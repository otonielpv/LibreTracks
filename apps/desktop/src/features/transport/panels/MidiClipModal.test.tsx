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
      lead: null,
    });

    fireEvent.click(container.querySelector(".lt-modal-backdrop") as Element);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("saves the lead chosen in the editor and keeps an existing one", () => {
    const onConfirm = vi.fn();
    const draft = {
      clipId: "clip-1",
      trackId: "midi-track-1",
      timelineStartSeconds: 8,
      name: "Verse 2 lyrics",
      events: [
        {
          id: "event-1",
          atSeconds: 0,
          channel: null,
          kind: { type: "programChange" as const, program: 4 },
        },
      ],
    };

    const { unmount } = render(
      <MidiClipModal
        draft={{ ...draft, lead: { unit: "beats", count: 2 } }}
        song={null}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    // An existing lead shows as its preset.
    const select = screen.getByLabelText("transport.lead.label") as HTMLSelectElement;
    expect(select.value).toBe("twoBeats");
    fireEvent.change(select, { target: { value: "oneBar" } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    expect(onConfirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ lead: { unit: "bars", count: 1 } }),
    );
    unmount();

    // Custom: any amount in any unit.
    render(
      <MidiClipModal draft={draft} song={null} onCancel={vi.fn()} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText("transport.lead.label"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("transport.lead.unit"), {
      target: { value: "seconds" },
    });
    fireEvent.change(screen.getByLabelText("transport.lead.amount"), {
      target: { value: "0.75" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    expect(onConfirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ lead: { unit: "seconds", seconds: 0.75 } }),
    );
  });

  it("remembers which messages were folded when the clip is opened again", () => {
    const draft = {
      clipId: "fold-clip",
      trackId: "midi-track-1",
      timelineStartSeconds: 8,
      name: "Folds",
      events: [
        { id: "e1", atSeconds: 0, channel: null, kind: { type: "programChange" as const, program: 1 } },
        { id: "e2", atSeconds: 0, channel: null, kind: { type: "programChange" as const, program: 2 } },
      ],
    };
    const first = render(
      <MidiClipModal draft={draft} song={null} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    const toggles = () => first.container.querySelectorAll<HTMLButtonElement>(".lt-midi-event-toggle");
    fireEvent.click(toggles()[0]);
    expect(toggles()[0].getAttribute("aria-expanded")).toBe("false");
    first.unmount();

    const again = render(
      <MidiClipModal draft={draft} song={null} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    const reopened = again.container.querySelectorAll<HTMLButtonElement>(".lt-midi-event-toggle");
    expect(reopened[0].getAttribute("aria-expanded")).toBe("false");
    expect(reopened[1].getAttribute("aria-expanded")).toBe("true");
    again.unmount();

    // A brand-new clip starts with everything open.
    const fresh = render(
      <MidiClipModal draft={{ ...draft, clipId: null }} song={null} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(
      Array.from(fresh.container.querySelectorAll(".lt-midi-event-toggle")).every(
        (toggle) => toggle.getAttribute("aria-expanded") === "true",
      ),
    ).toBe(true);
  });
});
