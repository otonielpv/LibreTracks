import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../frameGate";
import { useTransportStore } from "../store";
import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { testRegion, testSetlistProps } from "./testBindings";
import { classifySetlistLayout, type SetlistLayoutClass } from "./useSetlistLayout";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));
vi.mock("../tracks/TrackMeter", () => ({ SongMasterMeter: () => null, TrackMeter: () => null }));
vi.mock("../structure/ArrangementBadge", () => ({ ArrangementBadge: () => null }));

/**
 * Step 18's device matrix, as the area the view gets (the device in
 * landscape minus the app's bars: ~60 px on phones, ~120 px on tablets and
 * desktop windows, the side rail on the left).
 */
const DEVICES: Array<{ name: string; width: number; height: number; expected: SetlistLayoutClass }> = [
  { name: "Android phone (800×360)", width: 740, height: 300, expected: "short" },
  { name: "Android tablet Tab A7 (1340×800)", width: 1280, height: 680, expected: "wide" },
  { name: "iPhone 13 (844×390, notch)", width: 690, height: 255, expected: "short" },
  { name: "iPad (1180×820)", width: 1120, height: 700, expected: "medium" },
  { name: "iPad Pro 12.9 (1366×1024)", width: 1306, height: 900, expected: "wide" },
  { name: "Desktop window 1024×600", width: 964, height: 520, expected: "medium" },
  { name: "Desktop window 900×480", width: 840, height: 400, expected: "short" },
];

let viewSize = { width: 0, height: 0 };
class SizedResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback(
      [{ contentRect: { width: viewSize.width, height: viewSize.height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  disconnect() {}
}

const regions = [
  testRegion("a", { name: "Alfa", startSeconds: 0, endSeconds: 60 }),
  testRegion("b", { name: "Beta", startSeconds: 60, endSeconds: 120 }),
];
const zones = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-setlist-zone]")).map((zone) => zone.dataset.setlistZone);

// The hook also reads the root's client size once (jsdom says 0): give the
// view's root the same size the observer reports, as a browser would.
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains("lt-setlist-view") ? viewSize.width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains("lt-setlist-view") ? viewSize.height : 0;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useTransportStore.setState({ playback: { playbackState: "stopped" } as never });
  vi.stubGlobal("ResizeObserver", SizedResizeObserver);
});
afterEach(() => {
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// C1: per device, the measured class and the zones it paints.
describe.each(DEVICES)("$name", ({ width, height, expected }) => {
  it(`is ${expected} and paints its zones`, () => {
    expect(classifySetlistLayout(width, height)).toBe(expected);
    viewSize = { width, height };
    const base = testSetlistProps({ regions } as Partial<SongView>);
    const { container } = render(<SetlistView {...base} selectedRegionId="a" />);
    expect(container.querySelector(".lt-setlist-view")?.getAttribute("data-setlist-layout")).toBe(expected);
    expect(zones(container)).toEqual(expected === "short" ? ["songs", "mixer"] : ["songs", "overview", "mixer"]);
  });
});

// C2: stopped, nothing of the view keeps the display awake (memory
// project_idle_power_android: ~1 core idle from rAF loops on Android).
describe("idle power", () => {
  it.each(["wide", "short"] as const)("%s: with playback stopped, rAF stops being asked for", (layout) => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    resetFrameGateForTests();
    viewSize = layout === "wide" ? { width: 1400, height: 800 } : { width: 700, height: 260 };
    const spy = vi.spyOn(window, "requestAnimationFrame");
    const base = testSetlistProps({ regions } as Partial<SongView>);
    render(<SetlistView {...base} selectedRegionId="a" />);
    act(() => useSetlistStore.getState().setShortPane("song"));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const asked = spy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(spy.mock.calls.length).toBe(asked);
  });

  it("while playing the loops keep running (the playhead moves)", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    resetFrameGateForTests();
    useTransportStore.setState({ playback: { playbackState: "playing" } as never });
    viewSize = { width: 1400, height: 800 };
    const spy = vi.spyOn(window, "requestAnimationFrame");
    const base = testSetlistProps({ regions } as Partial<SongView>);
    render(<SetlistView {...base} selectedRegionId="a" />);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const asked = spy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(spy.mock.calls.length).toBeGreaterThan(asked);
  });
});
