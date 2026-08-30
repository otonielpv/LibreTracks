import { afterEach, describe, expect, it } from "vitest";

import { InputManager, type TimelineNavigationScheme } from "./InputManager";

/**
 * Wheel gestures that change row height.
 *
 * The global height (every row at once) and the per-row height are two
 * different controls on the same wheel, so what matters here is which one each
 * modifier reaches — and that the modifier the user already had for the global
 * height still means the global height.
 */

type Recorded = {
  globalHeights: number[];
  rowSteps: Array<{ localY: number; deltaPx: number }>;
};

const managers: InputManager[] = [];

function setup(options: {
  navigationScheme: TimelineNavigationScheme;
  /** Leave the per-row handler out, as an older caller would. */
  withRowHandler?: boolean;
}) {
  const container = document.createElement("div");
  Object.defineProperty(container, "offsetWidth", { value: 800 });
  Object.defineProperty(container, "offsetHeight", { value: 400 });
  container.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 100,
      right: 800,
      bottom: 500,
      width: 800,
      height: 400,
    }) as DOMRect;
  document.body.append(container);

  const recorded: Recorded = { globalHeights: [], rowSteps: [] };

  const manager = new InputManager({
    container,
    getState: () => ({
      cameraX: 0,
      zoomLevel: 1,
      trackHeight: 80,
      canZoom: true,
      navigationScheme: options.navigationScheme,
    }),
    dragThresholdPx: 6,
    panCommitDelayMs: 100,
    zoomCommitDelayMs: 100,
    zoomMultiplier: 1.2,
    trackHeightStep: 8,
    trackHeightMin: 18,
    trackHeightMax: 148,
    onPreviewCameraX: (cameraX) => cameraX,
    onCommitCameraX: () => {},
    onPreviewZoom: (zoomLevel) => ({ cameraX: 0, zoomLevel }),
    onCommitZoom: () => {},
    onTrackHeightChange: (trackHeight) =>
      recorded.globalHeights.push(trackHeight),
    onTrackRowHeightStep:
      options.withRowHandler === false
        ? undefined
        : (localY, deltaPx) => recorded.rowSteps.push({ localY, deltaPx }),
  });
  managers.push(manager);

  const wheel = (init: WheelEventInit) => {
    container.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }),
    );
  };

  return { recorded, wheel };
}

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.destroy();
  }
  document.body.replaceChildren();
});

describe.each<TimelineNavigationScheme>(["ableton", "libretracks"])(
  "alt + wheel (%s scheme)",
  (navigationScheme) => {
    it("resizes the row under the pointer, not every row", () => {
      const { recorded, wheel } = setup({ navigationScheme });

      wheel({ deltaY: -100, altKey: true, clientY: 340 });

      // The container's top is at clientY 100, so the pointer is 240px into
      // the track area — that is what resolves the row.
      expect(recorded.rowSteps).toEqual([{ localY: 240, deltaPx: 8 }]);
      expect(recorded.globalHeights).toEqual([]);
    });

    it("shrinks the row when the wheel turns the other way", () => {
      const { recorded, wheel } = setup({ navigationScheme });

      wheel({ deltaY: 100, altKey: true, clientY: 100 });

      expect(recorded.rowSteps).toEqual([{ localY: 0, deltaPx: -8 }]);
    });
  },
);

describe("the global height keeps its own modifier", () => {
  it("ctrl + wheel still resizes every row in the libretracks scheme", () => {
    const { recorded, wheel } = setup({ navigationScheme: "libretracks" });

    wheel({ deltaY: -100, ctrlKey: true, clientY: 340 });

    expect(recorded.globalHeights).toEqual([88]);
    expect(recorded.rowSteps).toEqual([]);
  });

  it("alt + shift + wheel resizes every row in the ableton scheme", () => {
    // Ctrl is horizontal zoom there, so the global height needs a modifier of
    // its own now that plain Alt means "this row".
    const { recorded, wheel } = setup({ navigationScheme: "ableton" });

    wheel({ deltaY: 100, altKey: true, shiftKey: true, clientY: 340 });

    expect(recorded.globalHeights).toEqual([72]);
    expect(recorded.rowSteps).toEqual([]);
  });

  it("alt still resizes every row when no per-row handler is wired", () => {
    const { recorded, wheel } = setup({
      navigationScheme: "ableton",
      withRowHandler: false,
    });

    wheel({ deltaY: -100, altKey: true, clientY: 340 });

    expect(recorded.globalHeights).toEqual([88]);
  });
});
