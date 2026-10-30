import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MidiBinding, SongView } from "@libretracks/shared/models";

import { useTimelineUIStore } from "../uiStore";
import {
  describeMidiTarget,
  isOtherSessionTarget,
  mixerLearnKeys,
  trackIdOfTarget,
} from "./controllerTargets";
import { MidiBindingsEditor } from "./MidiBindingsEditor";
import { MidiMapBanner } from "./MidiMapBanner";
import { MidiMappable, useMidiMappable, useMidiMappingsStore } from "./MidiMappable";

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

describe("MIDI Map mode", () => {
  it("adds nothing around the control outside map mode", () => {
    useTimelineUIStore.getState().setMidiLearnMode(null);
    const { container } = render(
      <MidiMappable target="track:t1:mute">
        <button type="button">M</button>
      </MidiMappable>,
    );
    expect(container.innerHTML).toBe('<button type="button">M</button>');
  });

  it("tints the button itself in map mode and a tap arms the learn instead of muting", () => {
    useMidiMappingsStore.setState({
      mappings: { "track:t1:mute": { status: 0x90, data1: 36, isCc: false } },
    });
    useTimelineUIStore.getState().setMidiLearnMode("");
    const onClick = vi.fn();
    const { container } = render(
      <div className="lt-track-toggle-group">
        <MidiMappable target="track:t1:mute" label="Bass · M">
          <button type="button" className="lt-track-toggle-mute" onClick={onClick}>
            M
          </button>
        </MidiMappable>
      </div>,
    );
    // No wrapper: the button stays a direct child of its group, so the
    // group's "> button" and "button" rules keep sizing it.
    const button = container.querySelector(".lt-track-toggle-group > button")!;
    expect(button.className).toContain("lt-track-toggle-mute");
    expect(button.className).toContain("lt-midi-mappable");
    // The tint is a span, never a button a generic rule could restyle.
    const layer = button.querySelector(".lt-midi-mappable-layer")!;
    expect(layer.tagName).toBe("SPAN");
    expect(layer.className).toContain("is-mapped");
    expect(layer.textContent).toContain("Note On 36");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    fireEvent.click(button);
    expect(useTimelineUIStore.getState().midiLearnMode).toBe("track:t1:mute");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a container overlay (faders) arms the learn on tap", () => {
    useTimelineUIStore.getState().setMidiLearnMode("");
    function Fader() {
      const map = useMidiMappable("track:t1:volume", "Bass");
      return (
        <label className={map.className}>
          <input type="range" />
          {map.overlay}
        </label>
      );
    }
    render(<Fader />);
    fireEvent.click(screen.getByRole("button", { name: "midiMap.mapTarget" }));
    expect(useTimelineUIStore.getState().midiLearnMode).toBe("track:t1:volume");
  });

  it("banner names the armed target and exits map mode", () => {
    useTimelineUIStore.getState().setMidiLearnMode("strip:2:volume");
    render(<MidiMapBanner />);
    expect(screen.getByRole("status").textContent).toContain("midiMap.bannerTarget");
    fireEvent.click(screen.getByRole("button", { name: "midiMap.exit" }));
    expect(useTimelineUIStore.getState().midiLearnMode).toBeNull();
  });

  it("tapping the banner moves it to the other edge, so it never hides a sheet", () => {
    useTimelineUIStore.getState().setMidiLearnMode("");
    render(<MidiMapBanner />);
    const banner = screen.getByRole("status");
    expect(banner.className).not.toContain("is-top");
    fireEvent.click(screen.getByRole("button", { name: "midiMap.moveBanner" }));
    expect(banner.className).toContain("is-top");
    expect(useTimelineUIStore.getState().midiLearnMode).toBe("");
  });

  it("edits and removes bindings, marking another session's tracks", () => {
    const onChange = vi.fn();
    const mappings: Record<string, MidiBinding> = {
      "track:gone:volume": { status: 0xb0, data1: 7, isCc: true },
    };
    render(
      <MidiBindingsEditor
        midiMappings={mappings}
        describe={(key) => key}
        disabled={false}
        onChange={onChange}
      />,
    );
    expect(screen.getAllByText("midiMap.otherSession").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("spinbutton", { name: "midiMap.max" }), {
      target: { value: "50" },
    });
    expect(onChange).toHaveBeenLastCalledWith("track:gone:volume", {
      status: 0xb0,
      data1: 7,
      isCc: true,
      max: 0.5,
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "midiMap.invert" }));
    expect(onChange.mock.lastCall?.[1].invert).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "midiMap.remove" }));
    expect(onChange).toHaveBeenLastCalledWith("track:gone:volume", null);
  });
});

describe("controllerTargets", () => {
  const song = { tracks: [{ id: "bass", name: "Bajo" }] } as unknown as SongView;

  it("names tracks, strips, banks and app faders", () => {
    expect(describeMidiTarget("track:bass:volume", t, song)).toBe("Bajo · midiMap.volume");
    expect(describeMidiTarget("track:x:mute", t, song)).toBe(
      "midiMap.otherSession · midiMap.mute",
    );
    expect(describeMidiTarget("strip:3:pan", t, song)).toBe(
      'midiMap.strip:{"index":"3"} · midiMap.pan',
    );
    expect(describeMidiTarget("bank:next", t, song)).toBe("midiMap.bankNext");
    expect(describeMidiTarget("mixer:pads:volume", t, song)).toBe("midiMap.pads");
    expect(describeMidiTarget("action:play", t, song)).toBeNull();
  });

  it("knows which track bindings belong to another session", () => {
    expect(trackIdOfTarget("track:bass:solo")).toBe("bass");
    expect(isOtherSessionTarget("track:bass:solo", song)).toBe(false);
    expect(isOtherSessionTarget("track:zzz:solo", song)).toBe(true);
    expect(isOtherSessionTarget("strip:1:solo", song)).toBe(false);
  });

  it("lists 8 strips x 4 controls, the banks and the 4 app faders", () => {
    const keys = mixerLearnKeys();
    expect(keys).toHaveLength(8 * 4 + 2 + 4);
    expect(keys).toContain("strip:8:solo");
    expect(keys).toContain("mixer:song_master:volume");
  });
});
