import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS, type RhythmLibrary } from "@libretracks/shared/models";

import { rhythmTriggerCallsForTest, setRhythmLibraryForTest } from "../../../app/testDesktopApiMock";
import { act, fireEvent, render, screen, waitFor } from "../../../test/testUtils";
import { MIDI_LEARN_COMMANDS } from "../constants";
import { SHORTCUT_ACTIONS } from "../keyboard/actions";
import { useTimelineUIStore } from "../uiStore";
import { RhythmPanel } from "./RhythmPanel";
import { RHYTHM_SHORTCUT_HANDLERS } from "./rhythmShortcuts";

const library: RhythmLibrary = {
  kits: [
    {
      id: "kit",
      name: "Kit",
      sounds: [{ id: "hat", name: "Hat", color: "", sample: { source: { kind: "builtin" }, file: "hat.wav" }, gainDb: 0 }],
    },
  ],
  patterns: [
    {
      id: "pop",
      name: "Pop",
      kit: { kind: "library", kitId: "kit" },
      bpm: 100,
      signature: { numerator: 4, denominator: 4 },
      stepsPerBeat: 4,
      bars: 1,
      swing: 0,
      rows: [{ soundId: "hat", gainDb: 0, variations: [new Array(16).fill(0)] }],
    },
  ],
  oneShots: {
    banks: [
      {
        id: "a",
        name: "A",
        pads: [
          {
            id: "boom",
            name: "Boom",
            color: "",
            sample: { source: { kind: "user" }, file: "boom.wav" },
            gainDb: 0,
            mode: "oneShot",
            quantize: "off",
          },
        ],
      },
    ],
  },
};

function key(code: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", { code, key: code, ...init });
}

beforeEach(() => {
  setRhythmLibraryForTest(library);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

describe("rhythm in MIDI map mode", () => {
  it("rows, variation chips, pads and the loop button are mappable and learn instead of playing", async () => {
    useTimelineUIStore.setState({ midiLearnMode: "" });
    render(
      <RhythmPanel
        variant="docked"
        layoutClass="wide"
        settings={{ ...DEFAULT_APP_SETTINGS, activeLoopPatternId: "pop" }}
        onSettings={() => {}}
      />,
    );
    await screen.findByTestId("rhythm-rows");
    const rowToggle = screen.getByRole("button", { name: "Turn Hat on or off" });
    expect(rowToggle.className).toContain("lt-midi-mappable");
    expect(screen.getAllByRole("button", { name: "Variation B" })[0].className).toContain("lt-midi-mappable");
    const pad = screen.getByTestId("rhythm-pad-0");
    expect(pad.className).toContain("lt-midi-mappable");
    expect(screen.getByRole("button", { name: "Start loop" }).className).toContain("lt-midi-mappable");

    fireEvent.pointerDown(pad);
    fireEvent.click(pad);
    expect(useTimelineUIStore.getState().midiLearnMode).toBe("oneshot:1");
    fireEvent.click(rowToggle);
    expect(useTimelineUIStore.getState().midiLearnMode).toBe("loop:row:1:toggle");
    fireEvent.click(screen.getAllByRole("button", { name: "Variation C" })[0]);
    expect(useTimelineUIStore.getState().midiLearnMode).toBe("loop:row:1:var:c");
    await Promise.resolve();
    expect(rhythmTriggerCallsForTest).toEqual([]);
    useTimelineUIStore.setState({ midiLearnMode: null });
  });

  it("every rhythm MIDI target is in the learn list", () => {
    const keys = MIDI_LEARN_COMMANDS.map((c) => c.key);
    for (const target of [
      "action:loop_toggle",
      "action:loop_tap",
      "action:oneshots_stop_all",
      "loop:pattern:next",
      "loop:var:a",
      "loop:row:8:toggle",
      "oneshot:12",
      "oneshot:bank:d",
      "mixer:loops:volume",
      "mixer:oneshots:volume",
    ]) {
      expect(keys).toContain(target);
    }
  });
});

describe("rhythm keyboard shortcuts", () => {
  it("are registered with defaults only for the loop and the variations", () => {
    const byId = new Map(SHORTCUT_ACTIONS.map((a) => [a.id, a]));
    expect(byId.get("rhythm.loopToggle")?.defaultBinding).toBe("Alt+L");
    expect(byId.get("rhythm.variationC")?.defaultBinding).toBe("Alt+3");
    expect(byId.get("rhythm.pad1")?.defaultBinding).toBeNull();
    expect(byId.get("rhythm.stopAllPads")?.defaultBinding).toBeNull();
    for (const id of Object.keys(RHYTHM_SHORTCUT_HANDLERS)) expect(byId.has(id as never)).toBe(true);
  });

  it("fire the same commands as the panel; a pad sounds while the key is held", async () => {
    RHYTHM_SHORTCUT_HANDLERS["rhythm.loopToggle"](key("KeyL", { altKey: true }));
    RHYTHM_SHORTCUT_HANDLERS["rhythm.variationB"](key("Digit2", { altKey: true }));
    RHYTHM_SHORTCUT_HANDLERS["rhythm.variationB"](key("Digit2", { altKey: true, repeat: true }));
    RHYTHM_SHORTCUT_HANDLERS["rhythm.pad3"](key("KeyQ"));
    await waitFor(() => expect(rhythmTriggerCallsForTest).toHaveLength(3));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyQ" }));
    });
    await waitFor(() => expect(rhythmTriggerCallsForTest).toHaveLength(4));
    expect(rhythmTriggerCallsForTest.map((c) => c.command)).toEqual([
      "loop_toggle",
      "loop_set_all_rows",
      "one_shot_down",
      "one_shot_up",
    ]);
    expect(rhythmTriggerCallsForTest[1].args).toEqual({ variation: 1 });
    expect(rhythmTriggerCallsForTest[3].args).toEqual({ pad: 2 });
  });
});
