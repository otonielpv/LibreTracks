// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TIMELINE_RULER_HEIGHT } from "../constants";
import { createTimelineVerticalScroller } from "../timeline/timelineVerticalScroll";
import { useTimelineUIStore } from "../uiStore";
import { buildTrackRowLayout, type TrackRowLayout } from "./trackLayout";
import { trackRowSegments } from "./trackRowWindowing";
import {
  useTrackRowWindow,
  useTrackRowWindowController,
  useTrackRowWindowStore,
} from "./useTrackRowWindow";

/**
 * Paso 07 de `docs/plans/completed/track-virtualization`: la ventana de filas con el
 * scroller tactil del movil. Con el dedo no hay rueda: el scroller escribe
 * `scrollTop` (sin leerlo) y el navegador emite `scroll`.
 */

vi.mock("@libretracks/shared/desktopApi", async (original) => ({
  ...(await original<object>()),
  isMobileApp: true,
}));

// Movil en horizontal: un visor bajo.
const VIEWPORT_HEIGHT = 360;
const ROW_HEIGHT = 56;
const tracks = Array.from({ length: 140 }, (_, index) => ({ id: `t${index}` }));
const layout = buildTrackRowLayout(tracks, ROW_HEIGHT);

type FrameCallback = (now: number) => void;
let frames: FrameCallback[] = [];

function flushFrames() {
  const pending = frames;
  frames = [];
  pending.forEach((callback) => callback(0));
}

let rendered: ReturnType<typeof useTrackRowWindow> | null = null;

function Harness({ viewport }: { viewport: HTMLElement }) {
  const viewportRef = useRef<HTMLElement | null>(viewport);
  useTrackRowWindowController({ viewportRef, layout, tracks });
  rendered = useTrackRowWindow(layout, tracks);
  return null;
}

function mountViewport() {
  const element = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => VIEWPORT_HEIGHT });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  document.body.appendChild(element);
  render(<Harness viewport={element} />);
  return element;
}

/** El dedo arrastra: el scroller escribe, el navegador avisa con `scroll`. */
function fingerScroll(viewport: HTMLElement, delta: number) {
  const scroller = createTimelineVerticalScroller(
    () => viewport,
    () => TIMELINE_RULER_HEIGHT + layout.totalHeight,
  );
  act(() => {
    scroller.scrollBy(delta);
    viewport.dispatchEvent(new Event("scroll"));
    flushFrames();
  });
}

function mountedHeight(rowLayout: TrackRowLayout) {
  return trackRowSegments(rowLayout, rendered!).reduce(
    (sum, segment) =>
      sum + (segment.kind === "row" ? rowLayout.heights[segment.index] : segment.height),
    0,
  );
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  useTimelineUIStore.setState({ expandedTrackId: null });
});

afterEach(() => {
  cleanup();
  rendered = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  useTrackRowWindowStore.setState({
    metrics: null,
    pressedTrackId: null,
    focusedTrackId: null,
    onRowsMounted: null,
  });
});

describe("track row window on mobile", () => {
  it("uses the mobile ruler height", () => {
    expect(TIMELINE_RULER_HEIGHT).toBe(94);
  });

  it("follows the touch scroller, which writes scrollTop without a wheel event", () => {
    const viewport = mountViewport();
    expect(rendered).toMatchObject({ isWindowed: true, startIndex: 0 });

    fingerScroll(viewport, 4000);

    const firstVisibleRow = layout.rowAt(4000);
    const lastVisibleRow = layout.rowAt(4000 + VIEWPORT_HEIGHT - TIMELINE_RULER_HEIGHT);
    expect(rendered!.startIndex).toBeGreaterThan(0);
    expect(rendered!.startIndex).toBeLessThanOrEqual(firstVisibleRow);
    expect(rendered!.endIndex).toBeGreaterThan(lastVisibleRow);
  });

  it("keeps the expanded track mounted while it scrolls away", () => {
    const viewport = mountViewport();
    act(() => useTimelineUIStore.getState().setExpandedTrackId("t1"));

    fingerScroll(viewport, 5000);

    expect(rendered!.startIndex).toBeGreaterThan(1);
    expect(rendered!.pinnedIndices).toEqual([1]);
    expect(mountedHeight(layout)).toBe(layout.totalHeight);
  });

  it("leaves the bottom stop where it was", () => {
    const viewport = mountViewport();

    // Un arrastre enorme: el scroller acota con regla + escena.
    fingerScroll(viewport, 1_000_000);

    const maxScrollTop = TIMELINE_RULER_HEIGHT + layout.totalHeight - VIEWPORT_HEIGHT;
    expect(viewport.scrollTop).toBe(maxScrollTop);
    expect(rendered!.endIndex).toBe(tracks.length);
    // El contenido mide lo mismo que sin ventana: el tope no se mueve.
    expect(mountedHeight(layout)).toBe(layout.totalHeight);
  });
});
