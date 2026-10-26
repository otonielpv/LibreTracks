import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MidiClipSummary, SongView, TrackSummary } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../frameGate";
import type { TimelineMenus } from "../menus/timelineMenus";
import { anchoredOffset, followOffset, OverviewZoom } from "./OverviewZoom";
import { SetlistMidiPanel, songMidiClips } from "./SetlistMidiPanel";
import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { testRegion, testSetlistProps } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));
vi.mock("../tracks/TrackMeter", () => ({ SongMasterMeter: () => null, TrackMeter: () => null }));
vi.mock("../structure/ArrangementBadge", () => ({ ArrangementBadge: () => null }));

const region = testRegion("r", { name: "Canción", startSeconds: 0, endSeconds: 60 });
const track = (id: string, kind: TrackSummary["kind"]) => ({ id, name: id, kind }) as TrackSummary;
const clip = (id: string, trackId: string, at: number): MidiClipSummary => ({
  id,
  trackId,
  timelineStartSeconds: at,
  name: `Clip ${id}`,
  events: [{ id: "e", atSeconds: 0, kind: { type: "programChange", program: 3 } }],
});
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  clips: [],
  sectionMarkers: [{ id: "c", name: "Coro", kind: "chorus", startSeconds: 20 }],
  midiClips: [clip("b", "lights", 30), clip("a", "lights", 4), clip("x", "lights", 90)],
} as unknown as SongView;

function menus(extra: Record<string, unknown> = {}) {
  return {
    openMenu: vi.fn(),
    createMidiClipAt: vi.fn(),
    editMidiClip: vi.fn(),
    openMidiClipMenu: vi.fn(),
    globalTrackListContextMenu: vi.fn(() => [{ label: "transport.midi.addTrack", onSelect: vi.fn() }]),
    trackContextMenu: vi.fn(() => [{ label: "common.rename" }]),
    toggleMidiTrackEnabled: vi.fn(),
    ...extra,
  };
}

function panel(tracks: TrackSummary[], menuMock = menus(), position = 12) {
  return render(
    <SetlistMidiPanel
      song={song}
      region={region}
      tracks={tracks}
      layout="short"
      menus={menuMock as unknown as TimelineMenus}
      positionSecondsRef={{ current: position }}
      waveformSummaries={{}}
      onSeek={vi.fn()}
      runShortcutAction={vi.fn()}
    />,
  );
}

beforeEach(() => {
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  resetFrameGateForTests();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("Edit → MIDI", () => {
  it("the song's clips in time order, on the waveform and in the list", () => {
    expect(songMidiClips(song, region).map((entry) => entry.id)).toEqual(["a", "b"]);
    const menuMock = menus();
    const { container } = panel([track("lights", "midi")], menuMock);
    expect(Array.from(container.querySelectorAll(".lt-setlist-scrub-midi")).map((node) => node.textContent)).toEqual([
      "pianoClip a",
      "pianoClip b",
    ]);
    fireEvent.click(container.querySelectorAll<HTMLElement>(".lt-setlist-scrub-midi")[1]);
    expect(menuMock.editMidiClip).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    const rows = container.querySelectorAll<HTMLElement>(".lt-setlist-automation-item");
    expect(within(rows[1]).getByText("Coro")).toBeTruthy();
    expect(within(rows[1]).getByText("PC 3")).toBeTruthy();
  });

  it("«MIDI here» creates at the line on the track chosen in the row (the first by default)", () => {
    const two = menus();
    panel([track("lights", "midi"), track("propresenter", "midi")], two);
    fireEvent.click(screen.getByRole("button", { name: /setlistView.midi.addHere/ }));
    expect(two.createMidiClipAt).toHaveBeenLastCalledWith("lights", 12);
    fireEvent.click(screen.getByRole("radio", { name: "propresenter" }));
    expect(screen.getByRole("radio", { name: "propresenter" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /setlistView.midi.addHere/ }));
    expect(two.createMidiClipAt).toHaveBeenLastCalledWith("propresenter", 12);
  });

  // The iPhone report: no way to rename, delete or route a MIDI track here.
  it("the track row turns a track on/off and opens the DAW's track menu", () => {
    const menuMock = menus();
    const off = { ...track("propresenter", "midi"), midiEnabled: false } as TrackSummary;
    panel([track("lights", "midi"), off], menuMock);
    fireEvent.click(screen.getByRole("button", { name: "transport.midi.enableTrack" }));
    expect(menuMock.toggleMidiTrackEnabled).toHaveBeenCalledWith("propresenter");
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.menu:lights" }));
    expect(menuMock.trackContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "lights" }));
    expect(menuMock.openMenu).toHaveBeenCalledWith(expect.anything(), "lights", [{ label: "common.rename" }]);
    // «Add MIDI track» stays in the row.
    expect(screen.getByRole("button", { name: "transport.midi.addTrack" })).toBeTruthy();
  });

  it("without MIDI tracks it offers the DAW's «Add MIDI track»", () => {
    const menuMock = menus();
    panel([track("drums", "audio")], menuMock);
    fireEvent.click(screen.getByRole("button", { name: /transport.midi.addTrack/ }));
    const [entry] = menuMock.globalTrackListContextMenu.mock.results[0].value as Array<{ onSelect: () => void }>;
    expect(entry.onSelect).toHaveBeenCalled();
  });
});

describe("Edit modes on the phone", () => {
  it("short: MIDI is there, Lanes is not (the DAW is the place for lanes on a phone)", () => {
    const base = testSetlistProps({ regions: [region] } as Partial<SongView>);
    render(<SetlistView {...base} layoutClass="short" />);
    act(() => useSetlistStore.getState().setEditMode("song"));
    expect(screen.getByRole("tab", { name: "setlistView.edit.modes.midi" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "setlistView.edit.modes.lanes" })).toBeNull();
  });

  // The iPhone report: Mix / Lyrics / Edit over the waveform's bottom right,
  // as Playback, folding to the side with an arrow.
  it("short, waveform pane: the view buttons sit in a dock over the waveform that folds away", () => {
    const base = testSetlistProps({ regions: [region] } as Partial<SongView>);
    const { container } = render(<SetlistView {...base} layoutClass="short" />);
    const songsZone = () => container.querySelector(".lt-setlist-zone.is-songs")!;
    // Console pane: they head the console's rail; the song row is all songs.
    const rail = container.querySelector<HTMLElement>(".lt-setlist-mixer-header")!;
    expect(within(rail).getByRole("button", { name: /setlistView.edit.button/ })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: /setlistView.pane.song/ })).toBeTruthy();
    expect(songsZone().querySelector(".lt-setlist-pane-toggle, .lt-setlist-edit-button")).toBeNull();
    act(() => useSetlistStore.getState().setShortPane("song"));
    const dock = container.querySelector<HTMLElement>(".lt-setlist-wave-dock")!;
    expect(within(dock).getByRole("button", { name: /setlistView.pane.mixer/ })).toBeTruthy();
    expect(songsZone().querySelector(".lt-setlist-pane-toggle")).toBeNull();
    fireEvent.click(within(dock).getByRole("button", { name: "setlistView.dock.hide" }));
    expect(dock.querySelector(".lt-setlist-pane-toggle")).toBeNull();
    fireEvent.click(within(dock).getByRole("button", { name: "setlistView.dock.show" }));
    expect(dock.querySelector(".lt-setlist-pane-toggle")).not.toBeNull();
  });

  it("short, lyrics pane: the view buttons are a rail beside the lyrics, not in the song row", () => {
    const base = testSetlistProps({ regions: [region] } as Partial<SongView>);
    const { container } = render(<SetlistView {...base} layoutClass="short" />);
    act(() => useSetlistStore.getState().setShortPane("lyrics"));
    const rail = container.querySelector<HTMLElement>(".lt-setlist-lyrics-pane .lt-setlist-view-rail")!;
    expect(within(rail).getByRole("button", { name: /setlistView.edit.button/ })).toBeTruthy();
    expect(container.querySelector(".lt-setlist-zone.is-songs .lt-setlist-pane-toggle")).toBeNull();
  });

  // The iPhone report: the key change showed nowhere, and the lyrics' expand
  // button did nothing.
  it("a key change shows on the song's card and on the band", () => {
    const keyed = { ...region, key: "D", keyChanges: [{ id: "k1", startSeconds: 20, key: "E" }] };
    const base = testSetlistProps({ regions: [keyed] } as Partial<SongView>);
    const { container } = render(<SetlistView {...base} layoutClass="wide" />);
    const card = container.querySelector(".lt-setlist-song-key")!;
    expect(card.textContent).toBe("D → E");
    act(() => useSetlistStore.getState().setEditMode(null));
    expect(container.querySelector(".lt-setlist-map-key")?.textContent).toContain("E");
  });

  it("the lyrics' expand button covers the window and goes back", async () => {
    const { SetlistLyrics } = await import("./SetlistLyrics");
    const { container } = render(
      <SetlistLyrics
        performance={testSetlistProps({ regions: [region] } as Partial<SongView>).performance}
        region={region}
        onClose={vi.fn()}
      />,
    );
    const root = container.querySelector(".lt-setlist-lyrics")!;
    expect(root.classList.contains("is-expanded")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "liveChart.expand" }));
    expect(root.classList.contains("is-expanded")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "liveChart.collapse" }));
    expect(root.classList.contains("is-expanded")).toBe(false);
  });

  it("wide keeps Lanes", () => {
    const base = testSetlistProps({ regions: [region] } as Partial<SongView>);
    render(<SetlistView {...base} layoutClass="wide" />);
    act(() => useSetlistStore.getState().setEditMode("song"));
    expect(screen.getByRole("tab", { name: "setlistView.edit.modes.lanes" })).toBeTruthy();
  });
});

describe("band zoom", () => {
  it("centres the playhead, never past the edges, and does nothing at 1×", () => {
    expect(followOffset(0.5, 400, 1)).toBe(0);
    expect(followOffset(0.5, 400, 4)).toBe(600);
    expect(followOffset(0, 400, 4)).toBe(0);
    expect(followOffset(1, 400, 4)).toBe(1200);
  });

  it("a pinch keeps the moment under the fingers where it was", () => {
    // 400 px window at 1×, fingers at 100 px: 25 % of the song. At 4× the
    // layer is 1600 px and its 25 % (400 px) must sit at 100 px.
    expect(anchoredOffset(0, 100, 400, 1, 4)).toBe(300);
    expect(anchoredOffset(300, 100, 400, 4, 1)).toBe(0);
  });

  it("touch: one finger drags the zoomed song, a tap seeks, two fingers zoom", () => {
    const original = window.PointerEvent;
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
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    useSetlistStore.setState({ overviewZoom: 4 });
    const onSeek = vi.fn();
    const { container } = render(
      <OverviewZoom startSeconds={0} endSeconds={60} positionSecondsRef={{ current: 0 }} onSeek={onSeek}>
        <div />
      </OverviewZoom>,
    );
    const viewport = container.querySelector<HTMLElement>(".lt-setlist-zoom-viewport")!;
    const layer = container.querySelector<HTMLElement>(".lt-setlist-zoom-layer")!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 400 });
    viewport.getBoundingClientRect = () => ({ left: 0, width: 400 }) as DOMRect;
    const touch = { pointerType: "touch" };

    fireEvent.pointerDown(viewport, { ...touch, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(window, { ...touch, pointerId: 1, clientX: 100 });
    expect(layer.style.transform).toBe("translate3d(-200px, 0, 0)");
    fireEvent.pointerUp(window, { ...touch, pointerId: 1, clientX: 100 });
    expect(onSeek).not.toHaveBeenCalled();

    // A tap at 200 px with the layer at -200 px: 400 of 1600 px = 15 s.
    layer.getBoundingClientRect = () => ({ left: -200, width: 1600 }) as DOMRect;
    fireEvent.pointerDown(viewport, { ...touch, pointerId: 2, clientX: 200 });
    fireEvent.pointerUp(window, { ...touch, pointerId: 2, clientX: 200 });
    expect(onSeek).toHaveBeenCalledWith(15);

    // Two fingers 100 px apart spread to 200: 4× → 8×.
    fireEvent.pointerDown(viewport, { ...touch, pointerId: 3, clientX: 150 });
    fireEvent.pointerDown(viewport, { ...touch, pointerId: 4, clientX: 250 });
    fireEvent.pointerMove(window, { ...touch, pointerId: 4, clientX: 350 });
    // While the fingers are down it only scales (no relayout per frame: the
    // sections' labels shivered); the real width lands on release.
    expect(layer.style.width).toBe("400%");
    expect(layer.style.transform).toContain("scaleX(2)");
    fireEvent.pointerUp(window, { ...touch, pointerId: 3 });
    expect(layer.style.width).toBe("400%");
    fireEvent.pointerUp(window, { ...touch, pointerId: 4 });
    expect(layer.style.width).toBe("800%");
    expect(layer.style.transform).not.toContain("scaleX");
    expect(onSeek).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: original });
    vi.unstubAllGlobals();
  });

  it("zoomed, the layer follows the playhead; the wheel slides it, Ctrl+wheel zooms; no zoom buttons", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const runFrames = () => act(() => frames.splice(0).forEach((callback) => callback(0)));
    const position = { current: 30 };
    useSetlistStore.setState({ overviewZoom: 4 });
    const { container } = render(
      <OverviewZoom startSeconds={0} endSeconds={60} positionSecondsRef={position}>
        <div />
      </OverviewZoom>,
    );
    const viewport = container.querySelector<HTMLElement>(".lt-setlist-zoom-viewport")!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 400 });
    const layer = container.querySelector<HTMLElement>(".lt-setlist-zoom-layer")!;
    // The desktop report: the zoom buttons are gone, gestures replace them.
    expect(screen.queryByRole("button")).toBeNull();
    expect(layer.style.width).toBe("400%");
    runFrames();
    expect(layer.style.transform).toBe("translate3d(-600px, 0, 0)");
    position.current = 45;
    runFrames();
    expect(layer.style.transform).toBe("translate3d(-1000px, 0, 0)");
    // Sub-pixel steps move it too: rounding made it step a whole pixel a few
    // times a second when zoomed (the iPhone's «low FPS» follow).
    position.current = 45.01;
    runFrames();
    expect(layer.style.transform).toMatch(/^translate3d\(-1000\.26\d*px, 0, 0\)$/);
    // The desktop report: zoomed in there was no way to move. The wheel
    // (or a trackpad swipe) slides the song; it stays there while stopped.
    fireEvent.wheel(viewport, { deltaY: 120 });
    expect(layer.style.transform).toMatch(/^translate3d\(-1120\.26\d*px, 0, 0\)$/);
    runFrames();
    expect(layer.style.transform).toMatch(/^translate3d\(-1120\.26\d*px, 0, 0\)$/);
    fireEvent.wheel(viewport, { deltaX: -200, deltaY: 10 });
    expect(layer.style.transform).toMatch(/^translate3d\(-920\.26\d*px, 0, 0\)$/);
    // Ctrl+wheel out, down to the whole song.
    for (let step = 0; step < 12; step += 1) fireEvent.wheel(viewport, { deltaY: 100, ctrlKey: true });
    runFrames();
    expect(layer.style.width).toBe("100%");
    expect(layer.style.transform).toBe("none");
    vi.unstubAllGlobals();
  });
});
