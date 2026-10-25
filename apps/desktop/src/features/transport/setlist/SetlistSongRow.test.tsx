import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler, type ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetFrameGateForTests } from "../frameGate";
import { SONG_REORDER_ID_ATTRIBUTE } from "../songs/useSongReorder";
import { useTransportStore } from "../store";
import { SetlistSongRow } from "./SetlistSongRow";
import { testRegion } from "./testBindings";
import type { SetlistLayoutClass } from "./useSetlistLayout";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

// Renders inside every wide/medium tile, so it counts tile renders per song.
const badgeRenders = vi.hoisted(() => [] as string[]);
vi.mock("../structure/ArrangementBadge", () => ({
  ArrangementBadge: ({ region }: { region: { id: string } }) => {
    badgeRenders.push(region.id);
    return null;
  },
}));

const regions = [
  testRegion("a", { name: "Alfa", startSeconds: 0, endSeconds: 100, key: "G" }),
  testRegion("b", { name: "Beta", startSeconds: 100, endSeconds: 220, key: "D" }),
  testRegion("c", { name: "Gamma", startSeconds: 220, endSeconds: 300, key: null }),
];

type RowProps = ComponentProps<typeof SetlistSongRow>;

function rowProps(overrides: Partial<RowProps> = {}): RowProps {
  return {
    regions,
    selectedRegionId: null,
    activeRegionId: null,
    pendingRegionId: null,
    bpmByRegion: { a: 72, b: 128, c: 90 },
    layout: "wide",
    positionSecondsRef: { current: 0 },
    transitionMode: "instant",
    onTransitionModeChange: vi.fn(),
    onSelectRegion: vi.fn(),
    onCueSong: vi.fn(),
    onPlaySong: vi.fn(),
    onSongContextMenu: vi.fn(),
    onReorderSong: vi.fn(),
    onDropOsFilesIntoSong: vi.fn(),
    onDropLibraryAssetsIntoSong: vi.fn(),
    onSnapshotApplied: vi.fn(),
    onImportSongPackageFromDialog: vi.fn(),
    onImportSongPackageFromOsFile: vi.fn(),
    ...overrides,
  };
}

const tiles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".lt-setlist-song-tile"));
const tile = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.lt-setlist-song-tile[data-region-id="${id}"]`)!;

function setPlayback(playbackState: "playing" | "stopped") {
  useTransportStore.setState({
    playback: { playbackState } as never,
  });
}

beforeEach(() => {
  badgeRenders.length = 0;
  setPlayback("stopped");
});

describe("SetlistSongRow content", () => {
  it.each<SetlistLayoutClass>(["wide", "medium"])(
    "%s: one card per song in snapshot order with name, key, BPM and duration",
    (layout) => {
      const { container } = render(<SetlistSongRow {...rowProps({ layout })} />);
      const cards = tiles(container);
      expect(cards.map((card) => card.dataset.regionId)).toEqual(["a", "b", "c"]);
      const first = within(cards[0]);
      expect(first.getByText("Alfa")).toBeTruthy();
      expect(first.getByText("G")).toBeTruthy();
      expect(first.getByText("72 BPM")).toBeTruthy();
      expect(first.getByText("1:40")).toBeTruthy();
      expect(within(cards[1]).getByText("2:00")).toBeTruthy();
    },
  );

  it("short: number, name and key in a vertical list", () => {
    const { container } = render(<SetlistSongRow {...rowProps({ layout: "short" })} />);
    expect(container.querySelector(".lt-setlist-songs.is-vertical")).not.toBeNull();
    const first = within(tiles(container)[0]);
    expect(first.getByText("1")).toBeTruthy();
    expect(first.getByText("Alfa")).toBeTruthy();
    expect(first.getByText("G")).toBeTruthy();
    expect(first.queryByText("72 BPM")).toBeNull();
  });

  it.each<SetlistLayoutClass>(["wide", "medium"])("%s: a horizontal row", (layout) => {
    const { container } = render(<SetlistSongRow {...rowProps({ layout })} />);
    expect(container.querySelector(".lt-setlist-songs.is-horizontal")).not.toBeNull();
  });

  it("a card has no value controls: no inputs, sliders or faders", () => {
    const { container } = render(<SetlistSongRow {...rowProps()} />);
    for (const card of tiles(container)) {
      expect(card.querySelector("input, select, textarea, [role='slider'], .lt-fader")).toBeNull();
      expect(card.querySelectorAll("button")).toHaveLength(2);
    }
  });
});

describe("SetlistSongRow gestures", () => {
  it("a click selects and, stopped, cues the song", () => {
    const props = rowProps();
    const { container } = render(<SetlistSongRow {...props} />);
    fireEvent.click(tile(container, "b"));
    expect(props.onSelectRegion).toHaveBeenCalledWith("b");
    expect(props.onCueSong).toHaveBeenCalledWith("b");
  });

  it("a click while sounding only selects", () => {
    setPlayback("playing");
    const props = rowProps();
    const { container } = render(<SetlistSongRow {...props} />);
    fireEvent.click(tile(container, "b"));
    expect(props.onSelectRegion).toHaveBeenCalledWith("b");
    expect(props.onCueSong).not.toHaveBeenCalled();
  });

  it("double click and the play button play the song", () => {
    const props = rowProps();
    const { container } = render(<SetlistSongRow {...props} />);
    fireEvent.doubleClick(tile(container, "c"));
    expect(props.onPlaySong).toHaveBeenCalledWith("c", "Gamma");

    fireEvent.click(screen.getByRole("button", { name: "setlistView.songs.play:Alfa" }));
    expect(props.onPlaySong).toHaveBeenCalledWith("a", "Alfa");
    // The button does not also select or cue.
    expect(props.onCueSong).not.toHaveBeenCalledWith("a");
  });

  it("right click and the «…» button open the DAW song menu", () => {
    const props = rowProps();
    const { container } = render(<SetlistSongRow {...props} />);
    fireEvent.contextMenu(tile(container, "a"));
    expect(props.onSongContextMenu).toHaveBeenLastCalledWith(expect.anything(), "a");
    fireEvent.click(screen.getByRole("button", { name: "setlistView.songs.menu:Beta" }));
    expect(props.onSongContextMenu).toHaveBeenLastCalledWith(expect.anything(), "b");
    expect(props.onSelectRegion).not.toHaveBeenCalled();
  });

  it("audio dropped on a card goes to that song", () => {
    const props = rowProps();
    const { container } = render(<SetlistSongRow {...props} />);
    const file = new File(["x"], "voz.wav");
    fireEvent.drop(tile(container, "b"), { dataTransfer: { files: [file], types: ["Files"] } });
    expect(props.onDropOsFilesIntoSong).toHaveBeenCalledWith("b", [file]);
  });

  it("a .ltpkg dropped on the row imports a new song", () => {
    const props = rowProps();
    const { container } = render(<SetlistSongRow {...props} />);
    const pkg = new File(["x"], "cancion.ltpkg");
    fireEvent.drop(tile(container, "b"), { dataTransfer: { files: [pkg], types: ["Files"] } });
    expect(props.onImportSongPackageFromOsFile).toHaveBeenCalledWith(pkg);
    expect(props.onDropOsFilesIntoSong).not.toHaveBeenCalled();
  });
});

describe("SetlistSongRow reorder", () => {
  const originalPointerEvent = window.PointerEvent;
  beforeAll(() => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
  });
  afterAll(() => {
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
  });

  it("dragging a card by its grip calls onReorderSong with the final index", () => {
    const props = rowProps();
    const { container } = render(<SetlistSongRow {...props} />);
    container
      .querySelectorAll<HTMLElement>(`[${SONG_REORDER_ID_ATTRIBUTE}]`)
      .forEach((element, index) => {
        element.getBoundingClientRect = () =>
          ({ left: index * 110, top: 0, width: 100, height: 40, right: index * 110 + 100, bottom: 40 }) as DOMRect;
      });
    const grip = within(tile(container, "a")).getByRole("button", { name: "liveView.reorderSong:Alfa" });
    const touch = { pointerId: 4, pointerType: "touch", button: 0 };
    act(() => {
      fireEvent.pointerDown(grip, { ...touch, clientX: 50 });
      fireEvent.pointerMove(window, { ...touch, clientX: 300 });
      fireEvent.pointerUp(window, { ...touch, clientX: 300 });
    });
    expect(props.onReorderSong).toHaveBeenCalledWith("a", 2);
  });

  it("dragging the card itself with the mouse reorders, like Compacta's song headers", () => {
    const props = rowProps();
    const { container } = render(<SetlistSongRow {...props} />);
    container
      .querySelectorAll<HTMLElement>(`[${SONG_REORDER_ID_ATTRIBUTE}]`)
      .forEach((element, index) => {
        element.getBoundingClientRect = () =>
          ({ left: index * 110, top: 0, width: 100, height: 40, right: index * 110 + 100, bottom: 40 }) as DOMRect;
      });
    const mouse = { pointerId: 5, pointerType: "mouse", button: 0 };
    act(() => {
      fireEvent.pointerDown(tile(container, "c"), { ...mouse, clientX: 250 });
      fireEvent.pointerMove(window, { ...mouse, clientX: 120 });
      fireEvent.pointerMove(window, { ...mouse, clientX: 20 });
      fireEvent.pointerUp(window, { ...mouse, clientX: 20 });
    });
    expect(props.onReorderSong).toHaveBeenCalledWith("c", 0);
  });
});

describe("SetlistSongRow rendering cost", () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    resetFrameGateForTests();
    setPlayback("playing");
  });
  afterEach(() => vi.unstubAllGlobals());

  const runFrames = () => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  };

  it("the sounding card's progress advances by rAF with no React render", () => {
    const positionSecondsRef = { current: 100 };
    let rowRenders = 0;
    const { container } = render(
      <Profiler id="row" onRender={() => (rowRenders += 1)}>
        <SetlistSongRow {...rowProps({ activeRegionId: "b", positionSecondsRef })} />
      </Profiler>,
    );
    runFrames();
    const fill = container.querySelector<HTMLElement>(".lt-setlist-song-progress-fill")!;
    expect(fill.style.transform).toBe("scaleX(0)");
    const rendersBefore = rowRenders;

    positionSecondsRef.current = 160;
    runFrames();
    expect(fill.style.transform).toBe("scaleX(0.5)");
    positionSecondsRef.current = 190;
    runFrames();
    expect(fill.style.transform).toBe("scaleX(0.75)");

    expect(rowRenders).toBe(rendersBefore);
  });

  it("changing the sounding song repaints only the two affected cards", () => {
    const props = rowProps({ activeRegionId: "a" });
    const { rerender } = render(<SetlistSongRow {...props} />);
    badgeRenders.length = 0;
    rerender(<SetlistSongRow {...props} activeRegionId="b" />);
    expect([...badgeRenders].sort()).toEqual(["a", "b"]);
  });
});
