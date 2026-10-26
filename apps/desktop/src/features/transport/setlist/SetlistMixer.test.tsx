import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView, TrackSummary } from "@libretracks/shared/models";

import type { MetronomeDeviceHandlers } from "../settings/metronomeDeviceHandlers";
import { SetlistView } from "./SetlistView";
import { songCardHeight } from "./useSongsRowResize";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { testRegion, testSetlistProps } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

vi.mock("../tracks/TrackMeter", () => ({
  SongMasterMeter: () => null,
  TrackMeter: () => null,
}));

vi.mock("../structure/ArrangementBadge", () => ({
  ArrangementBadge: () => null,
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: false,
  getPadsCatalog: vi.fn(async () => ({
    offline: false,
    pads: [{ id: "warm", name: "Warm", keysPresent: 12, keysPresentMask: new Array(12).fill(true) }],
  })),
}));

const track = (id: string, name: string): TrackSummary =>
  ({
    id,
    name,
    kind: "audio",
    depth: 0,
    hasChildren: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    audioTo: "master",
    transposeEnabled: true,
  }) as TrackSummary;

const regions = [
  testRegion("a", { name: "Alfa", startSeconds: 0, endSeconds: 100 }),
  testRegion("b", { name: "Beta", startSeconds: 100, endSeconds: 200 }),
];
const tracks = [track("shared", "Batería"), track("onlyA", "Voz A"), track("onlyB", "Voz B")];
const clip = (trackId: string, timelineStartSeconds: number) => ({
  id: `${trackId}-${timelineStartSeconds}`,
  trackId,
  timelineStartSeconds,
  durationSeconds: 50,
});
const songParts = {
  regions,
  tracks,
  clips: [clip("shared", 0), clip("onlyA", 10), clip("shared", 110), clip("onlyB", 120)],
} as unknown as Partial<SongView>;

function auxHandlers() {
  return {
    handleMetronomeVolumeDraftChange: vi.fn(),
    commitMetronomeVolumeDraft: vi.fn(),
    handleMetronomeEnabledChange: vi.fn(),
    handleMetronomeSoundChange: vi.fn(),
    handleVoiceGuideChange: vi.fn(),
    handleVoiceGuideVolumeDraftChange: vi.fn(),
    commitVoiceGuideVolumeDraft: vi.fn(),
    handleVoiceGuideEnabledChange: vi.fn(),
    handlePadChange: vi.fn(),
    handlePadVolumeDraftChange: vi.fn(),
    commitPadVolumeDraft: vi.fn(),
    handlePadEnabledChange: vi.fn(),
  } as unknown as MetronomeDeviceHandlers;
}

function props(overrides: Record<string, unknown> = {}) {
  const base = testSetlistProps(songParts);
  return { ...base, tracks, auxHandlers: auxHandlers(), ...overrides };
}

const stripNames = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll(".lt-compact-mixer-strip:not(.lt-setlist-master-strip) .lt-compact-mixer-strip-name-text"),
  ).map(
    (element) => element.textContent,
  );

const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
});
afterAll(() => {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
});

beforeEach(() => {
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("Setlist mixer tracks", () => {
  it("shows the selected song's tracks and follows the selection, not the playhead", () => {
    const base = props({ selectedRegionId: "a", activeRegionId: "a" });
    const { container, rerender } = render(<SetlistView {...base} layoutClass="wide" />);
    expect(stripNames(container)).toEqual(["Batería", "Voz A"]);

    // The playhead crosses into B: the console keeps mixing A.
    rerender(<SetlistView {...base} activeRegionId="b" layoutClass="wide" />);
    expect(stripNames(container)).toEqual(["Batería", "Voz A"]);

    rerender(<SetlistView {...base} selectedRegionId="b" activeRegionId="b" layoutClass="wide" />);
    expect(stripNames(container)).toEqual(["Batería", "Voz B"]);
  });

  it("the filter (the compact view's funnel) is on by default; off shows every track", () => {
    const { container } = render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="wide" />);
    const filter = screen.getByRole("button", { name: "setlistView.mixer.filter" });
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    expect(filter.textContent).toContain("filter_alt");
    fireEvent.click(filter);
    expect(filter.getAttribute("aria-pressed")).toBe("false");
    expect(filter.textContent).toContain("filter_alt_off");
    expect(stripNames(container)).toEqual(["Batería", "Voz A", "Voz B"]);
  });

  it("a fader drives the DAW's mixer handlers and the strip menu is the DAW's", () => {
    const base = props({ selectedRegionId: "a" });
    const onVolumeChange = vi.fn();
    const onCommitVolume = vi.fn();
    const onTrackContextMenu = vi.fn();
    render(
      <SetlistView
        {...base}
        mixerHandlers={{ ...base.mixerHandlers, onVolumeChange, onCommitVolume }}
        onTrackContextMenu={onTrackContextMenu}
        layoutClass="wide"
      />,
    );
    const fader = screen.getByRole("slider", { name: "Volume Batería" });
    fireEvent.keyDown(fader, { key: "ArrowUp" });
    fireEvent.keyUp(fader, { key: "ArrowUp" });
    expect(onVolumeChange).toHaveBeenCalledWith("shared", expect.any(Number));
    expect(onCommitVolume).toHaveBeenCalledWith("shared");

    fireEvent.contextMenu(fader.closest(".lt-compact-mixer-strip")!);
    expect(onTrackContextMenu).toHaveBeenCalledWith(expect.anything(), "shared");
  });

  it("with several tracks selected, offers the DAW's selection mix controls", () => {
    const { container } = render(
      <SetlistView {...props({ selectedRegionId: "a", selectedTrackIds: ["shared", "onlyA"] })} layoutClass="wide" />,
    );
    expect(container.querySelector(".lt-setlist-mixer-selection")).not.toBeNull();
  });
});

describe("Setlist console strips", () => {
  it("ends with the song Master; Click and Guide stay in the top bar", () => {
    const { container } = render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="wide" />);
    const order = Array.from(container.querySelectorAll("[data-console-strip]")).map((element) =>
      element.getAttribute("data-console-strip"),
    );
    expect(order).toEqual(["setlistView.mixer.master"]);
    expect(screen.queryByRole("tab", { name: "setlistView.mixer.tabs.click" })).toBeNull();
    const console = container.querySelector(".lt-setlist-console")!;
    expect(console.lastElementChild?.getAttribute("data-console-strip")).toBe("setlistView.mixer.master");
  });

  it("the Master strip drives the region master-gain handlers", () => {
    const onMasterGainChange = vi.fn();
    const onMasterGainCommit = vi.fn();
    render(
      <SetlistView
        {...props({ selectedRegionId: "b" })}
        onMasterGainChange={onMasterGainChange}
        onMasterGainCommit={onMasterGainCommit}
        layoutClass="wide"
      />,
    );
    const master = screen.getByRole("slider", { name: "setlistView.mixer.masterAria:Beta" });
    fireEvent.keyDown(master, { key: "ArrowDown" });
    fireEvent.keyUp(master, { key: "ArrowDown" });
    expect(onMasterGainChange).toHaveBeenCalledWith("b", expect.any(Number));
    expect(onMasterGainCommit).toHaveBeenCalledWith("b");
  });

  it("the Pads tab shows the pad controls with the catalog", async () => {
    const base = props({ selectedRegionId: "a" });
    render(<SetlistView {...base} layoutClass="wide" />);
    fireEvent.click(screen.getByRole("tab", { name: "setlistView.mixer.tabs.pads" }));
    const toggle = await screen.findByRole("checkbox", { name: "pads.enable" });
    fireEvent.click(toggle);
    expect(base.auxHandlers.handlePadEnabledChange).toHaveBeenCalledWith(true);
  });
});

describe("Setlist mixer hint and sizes", () => {
  it("the shared-tracks hint shows once and is remembered", () => {
    const { unmount } = render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="wide" />);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.mixer.gotIt" }));
    expect(screen.queryByText("setlistView.mixer.sharedTracksHint")).toBeNull();
    unmount();
    render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="wide" />);
    expect(screen.queryByText("setlistView.mixer.sharedTracksHint")).toBeNull();
  });

  it("survives a localStorage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="wide" />);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.mixer.gotIt" }));
    expect(screen.queryByText("setlistView.mixer.sharedTracksHint")).toBeNull();
  });

  it("wide: the top edge resizes the mixer and the height is committed once", () => {
    const { container } = render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="wide" />);
    const root = container.querySelector<HTMLElement>(".lt-setlist-view")!;
    const zone = container.querySelector<HTMLElement>("[data-setlist-zone='mixer']")!;
    root.getBoundingClientRect = () => ({ height: 1000, top: 0, left: 0, width: 1400 }) as DOMRect;
    zone.getBoundingClientRect = () => ({ height: 300, top: 700, left: 0, width: 1400 }) as DOMRect;
    const handle = screen.getByRole("separator", { name: "setlistView.mixer.resize" });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 700 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 600 });
    expect(root.style.getPropertyValue("--lt-setlist-mixer-height")).toBe("400px");
    expect(useSetlistStore.getState().mixerHeightPx).toBeNull();
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 100 });
    // Clamped to 60 % of the view.
    expect(useSetlistStore.getState().mixerHeightPx).toBe(600);
  });

  // The desktop report: the mixer resized, the song row did not.
  it("wide: the song row's bottom edge resizes it (cards wrap); a double click goes back to automatic", () => {
    const { container } = render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="wide" />);
    const root = container.querySelector<HTMLElement>(".lt-setlist-view")!;
    const zone = container.querySelector<HTMLElement>("[data-setlist-zone='songs']")!;
    root.getBoundingClientRect = () => ({ height: 1000, top: 0, left: 0, width: 1400 }) as DOMRect;
    zone.getBoundingClientRect = () => ({ height: 90, top: 0, left: 0, width: 1400 }) as DOMRect;
    const handle = screen.getByRole("separator", { name: "setlistView.songs.resize" });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 90 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 200 });
    expect(root.style.getPropertyValue("--lt-setlist-songs-height")).toBe("200px");
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 900 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 900 });
    // Clamped to half the view.
    expect(useSetlistStore.getState().songsHeightPx).toBe(500);
    expect(root.classList.contains("has-songs-height")).toBe(true);
    fireEvent.doubleClick(handle);
    expect(useSetlistStore.getState().songsHeightPx).toBeNull();
    expect(root.classList.contains("has-songs-height")).toBe(false);
  });

  it("medium: the mixer folds to a bar with the Master", () => {
    const { container } = render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="medium" />);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.mixer.collapse" }));
    const mixer = container.querySelector(".lt-setlist-mixer.is-collapsed")!;
    expect(stripNames(container)).toEqual([]);
    expect(within(mixer as HTMLElement).getAllByText("setlistView.mixer.master")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.mixer.expand" }));
    expect(stripNames(container)).toEqual(["Batería", "Voz A"]);
  });

  // Playback on an iPhone: the console is the phone's main screen, with the
  // same Tracks/Pads tabs as the bigger layouts.
  it("short: the console shows first, with its own Pads tab", async () => {
    const { container } = render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="short" />);
    expect(stripNames(container)).toEqual(["Batería", "Voz A"]);
    fireEvent.click(screen.getByRole("tab", { name: "setlistView.mixer.tabs.pads" }));
    expect(await screen.findByRole("checkbox", { name: "pads.enable" })).toBeTruthy();
  });

  it("short: no shared-tracks note (it would take half the console) and no fold", () => {
    const { container } = render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="short" />);
    expect(container.querySelector(".lt-setlist-mixer-hint")).toBeNull();
    expect(screen.queryByRole("button", { name: "setlistView.mixer.collapse" })).toBeNull();
    // Header actions keep their names for screen readers (icon-only on screen).
    expect(screen.getByRole("button", { name: "setlistView.tracks.addAudio" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "setlistView.mixer.filter" })).toBeTruthy();
  });
});

describe("Setlist mixer: MIDI tracks", () => {
  // Step 13, C4: the strip's on/off and routing are the same commands as the
  // lane header (the DAW's MIDI handlers, through the menus).
  it("a MIDI track gets a strip without fader: on/off and routing", () => {
    const midi = { ...track("lights", "Luces"), kind: "midi", midiPort: "IAC", midiChannel: 2 } as TrackSummary;
    const menus = {
      toggleMidiTrackEnabled: vi.fn(),
      openMidiRouteEditor: vi.fn(),
      openMixScenes: vi.fn(),
    };
    const base = props({
      tracks: [...tracks, midi],
      menus,
      selectedRegionId: "a",
    });
    const midiSong = {
      ...base.performance.song,
      tracks: [...tracks, midi],
      midiClips: [{ id: "m", trackId: "lights", timelineStartSeconds: 5, name: "PC", events: [] }],
    } as unknown as SongView;
    const { container } = render(
      <SetlistView {...base} performance={{ ...base.performance, song: midiSong }} layoutClass="wide" />,
    );
    const strip = container.querySelector<HTMLElement>('.lt-compact-mixer-strip.is-midi[data-track-id="lights"]')!;
    expect(strip).not.toBeNull();
    expect(strip.querySelector(".lt-compact-mixer-fader")).toBeNull();
    fireEvent.click(within(strip).getByRole("button", { name: "transport.midi.disableTrack" }));
    expect(menus.toggleMidiTrackEnabled).toHaveBeenCalledWith("lights");
    fireEvent.click(within(strip).getByRole("button", { name: /setlistView.midi.routeAria/ }));
    expect(menus.openMidiRouteEditor).toHaveBeenCalledWith("lights");
  });
});


describe("phone console rail", () => {
  // The iPhone report: bare icons said nothing, and opening Pads hid the
  // other buttons until going back to Tracks.
  it("every button carries a word, and the track actions stay in Pads (taking you back to Tracks)", () => {
    const base = props({ selectedRegionId: "a", activeRegionId: "a" });
    const { container } = render(<SetlistView {...base} layoutClass="short" />);
    const rail = container.querySelector<HTMLElement>(".lt-setlist-mixer-header")!;
    const words = Array.from(rail.querySelectorAll(".lt-setlist-rail-label")).map((node) => node.textContent);
    expect(words).toEqual(
      expect.arrayContaining([
        "setlistView.mixer.tabs.tracks",
        "setlistView.mixer.tabs.pads",
        "setlistView.mixer.rail.audio",
        "setlistView.mixer.rail.filter",
        "setlistView.mixer.scenes",
        "setlistView.mixer.rail.enlarge",
      ]),
    );
    fireEvent.click(within(rail).getByRole("tab", { name: /setlistView.mixer.tabs.pads/ }));
    expect(useSetlistStore.getState().bottomTab).toBe("pads");
    const filter = within(rail).getByRole("button", { name: /setlistView.mixer.filter/ });
    fireEvent.click(filter);
    expect(useSetlistStore.getState().bottomTab).toBe("tracks");
    expect(filter.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("channel strip layout", () => {
  // The iPhone report: pan and output were unusable behind a button. They are
  // at the bottom of the strip, as in the compact view, with M/S/T beside the
  // fader to win height.
  it("M/S/T beside the fader, pan and output at the bottom, on a phone too", () => {
    const { container } = render(<SetlistView {...props({ selectedRegionId: "a" })} layoutClass="short" />);
    const strip = container.querySelector<HTMLElement>(".lt-compact-mixer-strip.is-fader-strip")!;
    const order = Array.from(strip.children).map((child) => child.className.split(" ")[0]);
    expect(order).toEqual([
      "lt-compact-mixer-strip-name",
      "lt-compact-mixer-strip-toggles",
      "lt-compact-mixer-fader-wrap",
      "lt-compact-mixer-pan-wrap",
      "lt-compact-mixer-audio-to",
    ]);
    expect(within(strip).getByRole("combobox")).toBeTruthy();
    expect(within(strip).getByRole("slider", { name: /Pan/ })).toBeTruthy();
    // No hidden «options» button any more.
    expect(strip.querySelector(".is-options")).toBeNull();
  });
});

describe("song cards in a resized row", () => {
  // The desktop report: a tall row with three songs lost most of its space.
  // The height dragged is how big the cards may get, shared by their rows and
  // never past a limit: the row is as tall as its cards.
  it("the cards share the height dragged, within a minimum and a maximum", () => {
    expect(songCardHeight(215, 1)).toBe(96);
    expect(songCardHeight(215, 3)).toBe(63);
    expect(songCardHeight(78, 1)).toBe(64);
    // Never shorter than the text needs, however small the row or many rows.
    expect(songCardHeight(20, 1)).toBe(48);
    expect(songCardHeight(150, 5)).toBe(48);
  });
});
