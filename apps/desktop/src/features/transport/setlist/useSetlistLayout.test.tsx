import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifySetlistLayout,
  useSetlistLayout,
  type SetlistLayoutClass,
} from "./useSetlistLayout";

describe("classifySetlistLayout", () => {
  it.each<[number, number, SetlistLayoutClass]>([
    [1200, 621, "wide"],
    [1199, 621, "medium"],
    [1200, 620, "medium"],
    [1600, 900, "wide"],
    [1000, 501, "medium"],
    [1000, 500, "short"],
    [1600, 500, "short"],
    [800, 380, "short"],
    [0, 0, "wide"],
    [1000, 0, "wide"],
    [Number.NaN, 700, "wide"],
  ])("%d x %d is %s", (width, height, expected) => {
    expect(classifySetlistLayout(width, height)).toBe(expected);
  });
});

type ObserverCallback = (
  entries: Array<{ contentRect: { width: number; height: number } }>,
) => void;

class FakeResizeObserver {
  static last: FakeResizeObserver | null = null;
  callback: ObserverCallback;
  constructor(callback: ObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.last = this;
  }
  observe() {}
  disconnect() {}
  resize(width: number, height: number) {
    act(() => this.callback([{ contentRect: { width, height } }]));
  }
}

function Probe({
  onRender,
  forced,
}: {
  onRender: (layout: SetlistLayoutClass) => void;
  forced?: SetlistLayoutClass;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const layout = useSetlistLayout(ref, forced);
  onRender(layout);
  return <div ref={ref} />;
}

describe("useSetlistLayout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("re-renders only when the size class changes", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const renders: SetlistLayoutClass[] = [];
    render(<Probe onRender={(layout) => renders.push(layout)} />);
    const observer = FakeResizeObserver.last!;
    const before = renders.length;

    observer.resize(1300, 800);
    observer.resize(1500, 900);
    observer.resize(1800, 700);
    expect(renders.length).toBe(before);
    expect(renders.at(-1)).toBe("wide");

    observer.resize(1000, 700);
    expect(renders.at(-1)).toBe("medium");
    const afterMedium = renders.length;
    observer.resize(1100, 600);
    observer.resize(900, 520);
    expect(renders.length).toBe(afterMedium);

    observer.resize(900, 400);
    expect(renders.at(-1)).toBe("short");
  });

  it("is wide without a ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const renders: SetlistLayoutClass[] = [];
    render(<Probe onRender={(layout) => renders.push(layout)} />);
    expect(renders.at(-1)).toBe("wide");
  });

  it("a forced class always wins", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const renders: SetlistLayoutClass[] = [];
    render(<Probe forced="short" onRender={(layout) => renders.push(layout)} />);
    expect(renders.at(-1)).toBe("short");
  });
});
