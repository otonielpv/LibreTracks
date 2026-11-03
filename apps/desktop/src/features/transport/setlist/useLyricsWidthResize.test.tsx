import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { clampLyricsWidth, LYRICS_MIN_WIDTH_PX, LYRICS_WIDTH_VAR, useLyricsWidthResize } from "./useLyricsWidthResize";

const STORAGE_KEY = "lt.setlistView.lyricsWidthPx";

function Harness() {
  const rootRef = useRef<HTMLElement | null>(null);
  const resize = useLyricsWidthResize(rootRef);
  return (
    <main ref={rootRef} data-testid="root">
      <div className="lt-setlist-band-row" data-testid="row">
        <div data-testid="viewport">
          <div className="lt-setlist-zoom-layer" data-testid="layer" />
        </div>
        <div data-testid="seam" onPointerDown={resize.begin} onDoubleClick={resize.reset} />
        <section className="lt-setlist-zone is-lyrics" data-testid="lyrics" />
      </div>
    </main>
  );
}

function rect(width: number) {
  return () => ({ width, height: 100, top: 0, left: 0, right: width, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
}

// jsdom has no PointerEvent (fireEvent.pointer* drops clientX and pointerId):
// a MouseEvent with a pointerId is enough here.
function pointer(type: string, clientX: number, target: Element | Window = window) {
  const event = new MouseEvent(type, { clientX, button: 0, bubbles: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}

afterEach(() => {
  window.localStorage.clear();
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
});

function layoutWidth(element: HTMLElement, property: "offsetWidth" | "clientWidth", value: () => number) {
  Object.defineProperty(element, property, { configurable: true, get: value });
}

describe("clampLyricsWidth", () => {
  it("keeps the lyrics between the minimum and 70% of the row", () => {
    expect(clampLyricsWidth(100, 1500)).toBe(LYRICS_MIN_WIDTH_PX);
    expect(clampLyricsWidth(600, 1500)).toBe(600);
    expect(clampLyricsWidth(1400, 1500)).toBe(1050);
    // A row too narrow for both limits keeps the minimum.
    expect(clampLyricsWidth(500, 300)).toBe(LYRICS_MIN_WIDTH_PX);
  });
});

describe("useLyricsWidthResize", () => {
  it("dragging the seam left widens the lyrics and remembers the width", () => {
    const { getByTestId } = render(<Harness />);
    getByTestId("row").getBoundingClientRect = rect(1500);
    getByTestId("lyrics").getBoundingClientRect = rect(400);

    pointer("pointerdown", 1100, getByTestId("seam"));
    pointer("pointermove", 900);
    expect(getByTestId("root").style.getPropertyValue(LYRICS_WIDTH_VAR)).toBe("600px");
    pointer("pointerup", 900);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("600");
  });

  it("restores the stored width and a double click goes back to automatic", () => {
    window.localStorage.setItem(STORAGE_KEY, "520");
    const { getByTestId } = render(<Harness />);
    expect(getByTestId("root").style.getPropertyValue(LYRICS_WIDTH_VAR)).toBe("520px");

    fireEvent.doubleClick(getByTestId("seam"));
    expect(getByTestId("root").style.getPropertyValue(LYRICS_WIDTH_VAR)).toBe("");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("zoomed in, freezes the waveform for the drag and keeps its pixels per second on release", () => {
    useSetlistStore.setState({ overviewZoom: 2 });
    const { getByTestId } = render(<Harness />);
    getByTestId("row").getBoundingClientRect = rect(1500);
    getByTestId("lyrics").getBoundingClientRect = rect(400);
    let viewportWidth = 1000;
    layoutWidth(getByTestId("layer"), "offsetWidth", () => 2000);
    layoutWidth(getByTestId("viewport"), "clientWidth", () => viewportWidth);

    pointer("pointerdown", 1100, getByTestId("seam"));
    expect(getByTestId("layer").style.width).toBe("2000px");
    pointer("pointermove", 900);
    // Nothing is recomputed mid-drag: the zoom only changes on release.
    expect(useSetlistStore.getState().overviewZoom).toBe(2);
    viewportWidth = 800;
    pointer("pointerup", 900);
    expect(useSetlistStore.getState().overviewZoom).toBe(2.5);
    expect(getByTestId("layer").style.width).toBe("250%");
  });

  it("unzoomed, leaves the waveform a percentage so the whole song keeps fitting", () => {
    const { getByTestId } = render(<Harness />);
    getByTestId("row").getBoundingClientRect = rect(1500);
    getByTestId("lyrics").getBoundingClientRect = rect(400);
    layoutWidth(getByTestId("layer"), "offsetWidth", () => 1000);
    layoutWidth(getByTestId("viewport"), "clientWidth", () => 800);

    pointer("pointerdown", 1100, getByTestId("seam"));
    expect(getByTestId("layer").style.width).toBe("");
    pointer("pointerup", 900);
    expect(useSetlistStore.getState().overviewZoom).toBe(1);
  });
});
