import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MidiClipSummary, SongView, TrackSummary } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../frameGate";
import type { TimelineMenus } from "../menus/timelineMenus";
import { followOffset, OverviewZoom } from "./OverviewZoom";
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

  it("«MIDI here» creates at the line on the only MIDI track, or asks which one", () => {
    const one = menus();
    const { unmount } = panel([track("lights", "midi")], one);
    fireEvent.click(screen.getByRole("button", { name: /setlistView.midi.addHere/ }));
    expect(one.createMidiClipAt).toHaveBeenCalledWith("lights", 12);
    unmount();

    const two = menus();
    panel([track("lights", "midi"), track("propresenter", "midi")], two);
    fireEvent.click(screen.getByRole("button", { name: /setlistView.midi.addHere/ }));
    const [, , actions] = two.openMenu.mock.calls[0] as [unknown, string, Array<{ label: string; onSelect: () => void }>];
    expect(actions.map((action) => action.label)).toEqual(["lights", "propresenter"]);
    actions[1].onSelect();
    expect(two.createMidiClipAt).toHaveBeenCalledWith("propresenter", 12);
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

  it("the buttons zoom in and back; zoomed, the layer follows the playhead", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const runFrames = () => act(() => frames.splice(0).forEach((callback) => callback(0)));
    const position = { current: 30 };
    const { container } = render(
      <OverviewZoom startSeconds={0} endSeconds={60} positionSecondsRef={position}>
        <div />
      </OverviewZoom>,
    );
    const viewport = container.querySelector<HTMLElement>(".lt-setlist-zoom-viewport")!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 400 });
    const layer = container.querySelector<HTMLElement>(".lt-setlist-zoom-layer")!;
    expect(screen.queryByRole("button", { name: "setlistView.overview.fit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "setlistView.lanes.zoomIn" }));
    fireEvent.click(screen.getByRole("button", { name: "setlistView.lanes.zoomIn" }));
    expect(layer.style.width).toBe("400%");
    runFrames();
    expect(layer.style.transform).toBe("translate3d(-600px, 0, 0)");
    position.current = 45;
    runFrames();
    expect(layer.style.transform).toBe("translate3d(-1000px, 0, 0)");
    fireEvent.click(screen.getByRole("button", { name: "setlistView.overview.fit" }));
    runFrames();
    expect(layer.style.width).toBe("100%");
    expect(layer.style.transform).toBe("none");
    vi.unstubAllGlobals();
  });
});
