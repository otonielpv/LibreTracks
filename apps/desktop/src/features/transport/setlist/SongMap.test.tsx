import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongView } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../frameGate";
import { useTransportStore } from "../store";
import { useTimelineUIStore } from "../uiStore";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { SongMap } from "./SongMap";
import { testRegion } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

const region = testRegion("r1", { name: "Canción", startSeconds: 0, endSeconds: 60 });
const marker = (id: string, startSeconds: number) =>
  ({ id, name: id, startSeconds, kind: "verse" }) as SectionMarkerSummary;
const markers = [marker("Verso", 4), marker("Coro", 20), marker("Puente", 40)];
const song = {
  bpm: 120,
  timeSignature: "4/4",
  regions: [region],
  sectionMarkers: markers,
  tempoMarkers: [],
  timeSignatureMarkers: [],
} as unknown as SongView;

type MapProps = ComponentProps<typeof SongMap>;

function mapProps(overrides: Partial<MapProps> = {}): MapProps {
  return {
    song,
    region,
    layout: "wide",
    positionSecondsRef: { current: 0 },
    pendingMarkerId: null,
    activeVamp: null,
    onMarkerAction: vi.fn(),
    onCancelPendingJump: vi.fn(),
    onCueSong: vi.fn(),
    onPlaySong: vi.fn(),
    onSectionContextMenu: vi.fn(),
    ...overrides,
  };
}

const block = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.lt-setlist-map-block[data-block-id="${id}"]`)!;

let frames: FrameRequestCallback[] = [];
const runFrames = () => {
  const pending = frames;
  frames = [];
  act(() => {
    for (const callback of pending) callback(0);
  });
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  resetFrameGateForTests();
  useTransportStore.setState({ playback: { playbackState: "stopped" } as never });
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useTimelineUIStore.setState({ midiLearnMode: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("SongMap blocks", () => {
  it.each(["wide", "medium", "short"] as const)("%s: one block per section plus the start", (layout) => {
    const { container } = render(<SongMap {...mapProps({ layout })} />);
    const ids = Array.from(container.querySelectorAll(".lt-setlist-map-block")).map(
      (element) => element.getAttribute("data-block-id"),
    );
    expect(ids).toEqual(["start:r1", "Verso", "Coro", "Puente"]);
    expect(container.querySelector(`.lt-setlist-map.is-${layout}`)).not.toBeNull();
  });

  it("no sections: one block named after the song and a hint", () => {
    render(<SongMap {...mapProps({ song: { ...song, sectionMarkers: [] } })} />);
    expect(screen.getByTitle("Canción")).toBeTruthy();
    expect(screen.getByText("setlistView.map.noSections")).toBeTruthy();
  });
});

describe("SongMap cues", () => {
  it("a cue at the same point as a section is still shown on the band", () => {
    const cue = { id: "aviso", name: "Entra coro", startSeconds: 20, kind: "custom", categoryOverride: "cue" } as SectionMarkerSummary;
    const { container } = render(<SongMap {...mapProps({ song: { ...song, sectionMarkers: [...markers, cue] } })} />);
    const label = container.querySelector<HTMLElement>(".lt-setlist-map-cue")!;
    expect(label.textContent).toContain("Entra coro");
    expect(parseFloat(label.style.left)).toBeCloseTo(100 / 3, 6);
  });

  it("while editing, the cues are left to the edit layer's handles", () => {
    const cue = { id: "aviso", name: "Entra coro", startSeconds: 20, kind: "custom", categoryOverride: "cue" } as SectionMarkerSummary;
    const { container } = render(<SongMap {...mapProps({ editing: true, song: { ...song, sectionMarkers: [...markers, cue] } })} />);
    expect(container.querySelector(".lt-setlist-map-cue")).toBeNull();
  });
});

describe("SongMap gestures", () => {
  it("a stopped click on a block schedules the jump with the Live primary action", () => {
    const props = mapProps();
    const { container } = render(<SongMap {...props} />);
    fireEvent.click(block(container, "Coro"));
    expect(props.onMarkerAction).toHaveBeenCalledWith(markers[1]);
  });

  it("while playing, a block needs a double click to schedule its jump", () => {
    useTransportStore.setState({ playback: { playbackState: "playing" } as never });
    const props = mapProps();
    const { container } = render(<SongMap {...props} />);
    const coro = block(container, "Coro");

    fireEvent.click(coro);
    fireEvent.click(coro);
    expect(props.onMarkerAction).not.toHaveBeenCalled();

    fireEvent.doubleClick(coro);
    expect(props.onMarkerAction).toHaveBeenCalledOnce();
    expect(props.onMarkerAction).toHaveBeenCalledWith(markers[1]);
  });

  it("a click on the pending block cancels the jump", () => {
    const props = mapProps({ pendingMarkerId: "Coro" });
    const { container } = render(<SongMap {...props} />);
    expect(block(container, "Coro").classList.contains("is-pending")).toBe(true);
    fireEvent.click(block(container, "Coro"));
    expect(props.onCancelPendingJump).toHaveBeenCalled();
    expect(props.onMarkerAction).not.toHaveBeenCalled();
  });

  it("the start block cues when stopped and needs a double click while sounding", () => {
    const props = mapProps();
    const { container } = render(<SongMap {...props} />);
    fireEvent.click(block(container, "start:r1"));
    expect(props.onCueSong).toHaveBeenCalledWith("r1");

    useTransportStore.setState({ playback: { playbackState: "playing" } as never });
    fireEvent.click(block(container, "start:r1"));
    expect(props.onPlaySong).not.toHaveBeenCalled();
    fireEvent.doubleClick(block(container, "start:r1"));
    expect(props.onPlaySong).toHaveBeenCalledWith("r1", "Canción");
  });

  it("right click opens the DAW section menu for that marker", () => {
    const props = mapProps();
    const { container } = render(<SongMap {...props} />);
    fireEvent.contextMenu(block(container, "Puente"));
    expect(props.onSectionContextMenu).toHaveBeenCalledWith(expect.anything(), "Puente");
  });

  // The iPhone report: looping needed better feedback. The vamp's span is
  // framed over the waveform with a «Looping» badge; the Loop button is gone
  // (the vamp lives in the top bar).
  it("a running vamp is framed over its span, and there is no Loop / Next button", () => {
    const props = mapProps({ layout: "short", activeVamp: { startSeconds: 20, endSeconds: 40 } });
    const { container } = render(<SongMap {...props} />);
    expect(block(container, "Coro").classList.contains("is-looping")).toBe(true);
    const frame = container.querySelector<HTMLElement>(".lt-setlist-map-vamp")!;
    expect(screen.getByRole("status", { name: "setlistView.map.looping" })).toBe(frame);
    expect(frame.style.width).not.toBe("");
    expect(screen.queryByRole("button", { name: /setlistView.map.loop|setlistView.map.next/ })).toBeNull();
  });

  it("no vamp, no frame", () => {
    const { container } = render(<SongMap {...mapProps()} />);
    expect(container.querySelector(".lt-setlist-map-vamp")).toBeNull();
  });
});

describe("SongMap live position", () => {
  it("0 renders while the playhead moves inside a block, exactly 1 when it crosses", () => {
    const positionSecondsRef = { current: 21 };
    let renders = 0;
    const { container } = render(
      <Profiler id="map" onRender={() => (renders += 1)}>
        <SongMap {...mapProps({ positionSecondsRef })} />
      </Profiler>,
    );
    runFrames();
    expect(block(container, "Coro").classList.contains("is-active")).toBe(true);
    const baseline = renders;

    positionSecondsRef.current = 25;
    runFrames();
    positionSecondsRef.current = 30;
    runFrames();
    const fill = container.querySelector<HTMLElement>(".lt-setlist-map-progress-fill")!;
    expect(fill.style.transform).toBe("scaleX(0.5)");
    expect(renders).toBe(baseline);

    positionSecondsRef.current = 41;
    runFrames();
    expect(renders).toBe(baseline + 1);
    expect(block(container, "Puente").classList.contains("is-active")).toBe(true);
  });
});

describe("SongMap keyboard cursor (paso 19)", () => {
  it("draws nothing new until the arrows set a cursor", () => {
    const { container } = render(<SongMap {...mapProps()} />);
    expect(container.querySelector(".is-cursor")).toBeNull();
    act(() => useSetlistStore.getState().setSectionCursorId("Coro"));
    expect(block(container, "Coro").classList.contains("is-cursor")).toBe(true);
    expect(container.querySelectorAll(".is-cursor")).toHaveLength(1);
  });

  it("is not drawn while editing", () => {
    useSetlistStore.setState({ sectionCursorId: "Coro" });
    const { container } = render(<SongMap {...mapProps({ editing: true })} />);
    expect(container.querySelector(".is-cursor")).toBeNull();
  });
});

describe("SongMap MIDI learn (paso 19, C2)", () => {
  it("maps each section to the jump_marker_N target Live uses", () => {
    useTimelineUIStore.setState({ midiLearnMode: "" });
    const { container } = render(<SongMap {...mapProps()} />);
    const targets = Array.from(container.querySelectorAll("[data-midi-target]")).map(
      (element) => element.getAttribute("data-midi-target"),
    );
    // Sections only, in time order; the implicit start has no marker.
    expect(targets).toEqual(["action:jump_marker_1", "action:jump_marker_2", "action:jump_marker_3"]);
  });

  it("a tap in Map mode arms the learn instead of jumping", () => {
    useTimelineUIStore.setState({ midiLearnMode: "" });
    const props = mapProps();
    const { container } = render(<SongMap {...props} />);
    fireEvent.click(block(container, "Coro"));
    expect(useTimelineUIStore.getState().midiLearnMode).toBe("action:jump_marker_2");
    expect(props.onMarkerAction).not.toHaveBeenCalled();
  });

  it("outside Map mode nothing MIDI is drawn", () => {
    const { container } = render(<SongMap {...mapProps()} />);
    expect(container.querySelector("[data-midi-target]")).toBeNull();
  });
});
