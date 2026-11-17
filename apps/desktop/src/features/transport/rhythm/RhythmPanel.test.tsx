import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS, type AppSettings, type RhythmLibrary } from "@libretracks/shared/models";

import {
  emitRhythmMetersForTest,
  rhythmTriggerCallsForTest,
  setRhythmLibraryForTest,
} from "../../../app/testDesktopApiMock";
import { act, fireEvent, render, screen, waitFor } from "../../../test/testUtils";
import { saveOneShotSet } from "../desktopApi";
import { resetFrameGateForTests } from "../frameGate";
import { loopRowsRenderCount } from "./LoopRows";
import { RhythmPanel, type RhythmPanelProps } from "./RhythmPanel";
import type { RhythmLayoutClass } from "./useRhythmLayout";

const originalPointerEvent = window.PointerEvent;
let frames: FrameRequestCallback[] = [];

// El beforeEach global de testUtils restaura PointerEvent: hay que instalarlo
// en cada test, no una vez.
function installPointerEvent() {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
}

afterAll(() => {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
});

beforeEach(() => {
  installPointerEvent();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  resetFrameGateForTests();
  setRhythmLibraryForTest(library(6));
});

afterEach(() => vi.unstubAllGlobals());

function runFrames(count = 2) {
  for (let i = 0; i < count; i += 1) {
    const pending = frames;
    frames = [];
    pending.forEach((cb) => cb(performance.now()));
  }
}

function library(rows: number): RhythmLibrary {
  const sounds = Array.from({ length: rows }, (_, i) => ({
    id: `s${i}`,
    name: `Sound ${i}`,
    color: "#57f1db",
    sample: { source: { kind: "builtin" as const }, file: `s${i}.wav` },
    gainDb: 0,
  }));
  const steps = (on: number[]) => Array.from({ length: 16 }, (_, i) => (on.includes(i) ? 2 : 0));
  return {
    kits: [{ id: "kit", name: "Kit", sounds }],
    patterns: [
      {
        id: "pop",
        name: "Pop 16ths",
        kit: { kind: "library", kitId: "kit" },
        bpm: 92,
        signature: { numerator: 4, denominator: 4 },
        stepsPerBeat: 4,
        bars: 1,
        swing: 0,
        rows: sounds.map((s) => ({
          soundId: s.id,
          gainDb: 0,
          variations: [steps([0, 4, 8, 12]), steps([2]), steps([]), steps([])],
        })),
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
              color: "#ff8800",
              sample: { source: { kind: "user" }, file: "boom.wav" },
              gainDb: 0,
              mode: "oneShot",
              quantize: "off",
            },
            {
              id: "riser",
              name: "Riser",
              color: "#8800ff",
              sample: { source: { kind: "user" }, file: "riser.wav" },
              gainDb: 0,
              mode: "gate",
              quantize: "off",
            },
          ],
        },
      ],
    },
  };
}

function renderPanel(props: Partial<RhythmPanelProps> & { layoutClass?: RhythmLayoutClass } = {}) {
  const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, activeLoopPatternId: "pop", ...props.settings };
  return render(
    <RhythmPanel variant="docked" settings={settings} onSettings={() => {}} layoutClass="wide" {...props} />,
  );
}

async function ready() {
  await screen.findByTestId("rhythm-rows");
}

describe("RhythmPanel", () => {
  it("pads send down on pointerdown and up on pointerup or pointercancel, two fingers at once", async () => {
    renderPanel();
    await ready();
    const boom = screen.getByTestId("rhythm-pad-0");
    const riser = screen.getByTestId("rhythm-pad-1");
    fireEvent.pointerDown(boom, { pointerId: 1 });
    fireEvent.pointerDown(riser, { pointerId: 2 });
    fireEvent.pointerCancel(riser, { pointerId: 2 });
    fireEvent.pointerUp(boom, { pointerId: 1 });
    // No hay click implicado: el down sale en pointerdown.
    await waitFor(() => expect(rhythmTriggerCallsForTest).toHaveLength(4));
    const byPad = (pad: number) =>
      rhythmTriggerCallsForTest.filter((c) => c.args.pad === pad).map((c) => c.command);
    expect(byPad(0)).toEqual(["one_shot_down", "one_shot_up"]);
    expect(byPad(1)).toEqual(["one_shot_down", "one_shot_up"]);
    // Un pointerup de un dedo que no pulsó nada no manda up.
    fireEvent.pointerUp(boom, { pointerId: 9 });
    await Promise.resolve();
    expect(rhythmTriggerCallsForTest).toHaveLength(4);
  });

  it("a new loop step does not re-render the rows but moves the strip by rAF", async () => {
    renderPanel();
    await ready();
    const rows = Array.from({ length: 6 }, () => ({ enabled: true, variation: 0 }));
    act(() => emitRhythmMetersForTest({ loopStep: 0, loopBar: 0, loopPlaying: true, loopRows: rows, oneShotsActive: 0 }));
    const before = loopRowsRenderCount.current;
    act(() => emitRhythmMetersForTest({ loopStep: 4, loopBar: 0, loopPlaying: true, loopRows: rows, oneShotsActive: 0 }));
    expect(loopRowsRenderCount.current).toBe(before);
    runFrames();
    const cells = screen.getByTestId("rhythm-row-0").querySelectorAll(".lt-rhythm-strip__cell");
    expect(cells[4].classList.contains("is-current")).toBe(true);
    expect(cells[0].classList.contains("is-current")).toBe(false);
  });

  it("a pending variation blinks until the engine says it is active", async () => {
    renderPanel();
    await ready();
    const chip = () => screen.getAllByRole("button", { name: "Variation B" })[0];
    fireEvent.click(chip());
    await waitFor(() =>
      expect(rhythmTriggerCallsForTest).toContainEqual({ command: "loop_set_row", args: { row: 0, variation: 1 } }),
    );
    act(() =>
      emitRhythmMetersForTest({
        loopStep: 3,
        loopBar: 0,
        loopPlaying: true,
        loopRows: [{ enabled: true, variation: 0, pendingVariation: 1 }],
        oneShotsActive: 0,
      }),
    );
    expect(chip().classList.contains("is-pending")).toBe(true);
    expect(chip().classList.contains("is-active")).toBe(false);
    act(() =>
      emitRhythmMetersForTest({
        loopStep: 0,
        loopBar: 0,
        loopPlaying: true,
        loopRows: [{ enabled: true, variation: 1 }],
        oneShotsActive: 0,
      }),
    );
    expect(chip().classList.contains("is-pending")).toBe(false);
    expect(chip().classList.contains("is-active")).toBe(true);
  });

  it("tap is only shown in free mode", async () => {
    const { unmount } = renderPanel();
    await ready();
    expect(screen.queryByRole("button", { name: "Tap" })).toBeNull();
    unmount();
    renderPanel({ settings: { ...DEFAULT_APP_SETTINGS, activeLoopPatternId: "pop", loopClockMode: "free" } });
    await ready();
    expect(screen.getByRole("button", { name: "Tap" })).toBeTruthy();
    expect(screen.getByText("92 BPM")).toBeTruthy();
  });

  it("wide: two columns with a step strip per row", async () => {
    renderPanel({ layoutClass: "wide" });
    await ready();
    expect(screen.getByTestId("rhythm-panel").dataset.layout).toBe("wide");
    expect(document.querySelector(".lt-rhythm-body.is-two-columns")).toBeTruthy();
    expect(document.querySelectorAll(".lt-rhythm-strip")).toHaveLength(6);
    expect(screen.queryByTestId("rhythm-surface-switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
  });

  it("medium: two columns with a pulse dot instead of the strip", async () => {
    renderPanel({ layoutClass: "medium" });
    await ready();
    expect(document.querySelector(".lt-rhythm-body.is-two-columns")).toBeTruthy();
    expect(document.querySelectorAll(".lt-rhythm-strip")).toHaveLength(0);
    expect(document.querySelectorAll(".lt-rhythm-pulse")).toHaveLength(6);
  });

  it("short: one surface with a switch, a ⋯ menu and two columns of rows past five", async () => {
    renderPanel({ layoutClass: "short", variant: "sheet" });
    await ready();
    expect(screen.getByTestId("rhythm-surface-switch")).toBeTruthy();
    expect(screen.queryByTestId("rhythm-one-shots")).toBeNull();
    expect(document.querySelector(".lt-rhythm-rows.is-two-columns")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Quantize" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByTestId("rhythm-more-menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "One shots" }));
    expect(screen.getByTestId("rhythm-one-shots")).toBeTruthy();
    expect(screen.queryByTestId("rhythm-rows")).toBeNull();
  });

  it("touch uses the 44 px target class, mouse does not", async () => {
    const { unmount } = renderPanel({ touch: true });
    await ready();
    expect(screen.getByTestId("rhythm-panel").classList.contains("is-touch")).toBe(true);
    unmount();
    renderPanel({ touch: false });
    await ready();
    expect(screen.getByTestId("rhythm-panel").classList.contains("is-touch")).toBe(false);
  });

  it("without a pattern shows the empty card", async () => {
    renderPanel({ settings: { ...DEFAULT_APP_SETTINGS, activeLoopPatternId: "" } });
    expect(await screen.findByTestId("rhythm-empty")).toBeTruthy();
  });

  it("edit mode: dragging a pad onto another swaps them", async () => {
    renderPanel({ onEdit: () => {} });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Edit pads" }));
    fireEvent.pointerDown(screen.getByTestId("rhythm-pad-0"), { pointerId: 1 });
    fireEvent.pointerUp(screen.getByTestId("rhythm-pad-1"), { pointerId: 1 });
    await waitFor(() => expect(saveOneShotSet).toHaveBeenCalled());
    const saved = vi.mocked(saveOneShotSet).mock.calls[0][0];
    expect(saved.banks[0].pads[0]?.id).toBe("riser");
    expect(saved.banks[0].pads[1]?.id).toBe("boom");
    expect(rhythmTriggerCallsForTest).toHaveLength(0);
  });
});
