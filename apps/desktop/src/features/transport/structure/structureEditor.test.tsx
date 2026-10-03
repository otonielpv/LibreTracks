import { renderHook } from "@testing-library/react";

import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import { act, en, fireEvent, render, screen, waitFor } from "../../../test/testUtils";
import { useSongStore } from "../songStore";
import { useSongWaveforms } from "../hooks/useSongWaveforms";
import { ArrangementBadge } from "./ArrangementBadge";
import { copySectionSpans, isCopyMarkerId } from "./copySpans";
import { SongStructurePanel } from "./SongStructurePanel";
import { createStructureHandlers } from "./structureHandlers";
import {
  addBlock,
  draftForArrangement,
  duplicateBlock,
  initialDraft,
  insertBlock,
  isDraftDirty,
  loadDraft,
  moveBlock,
  openStructureEditor,
  removeBlock,
  updateDraft,
} from "./structureEditor";
import { targetIndexForGap } from "./useBlockReorder";
import { useStructureStore, type ArrangementDraft } from "./structureStore";
import type { SongStructureSummary } from "./types";

const section = (markerId: string, name: string, start: number, end: number) => ({
  markerId,
  name,
  kind: "custom" as const,
  variant: null,
  color: null,
  implicit: false,
  startSeconds: start,
  endSeconds: end,
  bars: (end - start) / 2,
});

const STRUCTURE: SongStructureSummary = {
  sections: [
    section("intro", "Intro", 0, 8),
    section("verso", "Verso", 8, 24),
    section("coro", "Coro", 24, 40),
  ],
  arrangements: [
    {
      id: "domingo",
      name: "Domingo",
      blocks: [
        { id: "b1", sectionMarkerId: "intro" },
        { id: "b2", sectionMarkerId: "verso" },
        { id: "b3", sectionMarkerId: "coro" },
        { id: "b4", sectionMarkerId: "coro" },
      ],
    },
    { id: "corto", name: "Corto", blocks: [{ id: "c1", sectionMarkerId: "coro" }] },
  ],
  appliedArrangementId: "domingo",
};

function region(structure?: SongStructureSummary): SongRegionSummary {
  return {
    id: "r1",
    name: "Canción",
    startSeconds: 0,
    endSeconds: 48,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    structure,
  };
}

function songWith(structure?: SongStructureSummary): SongView {
  return {
    regions: [region(structure)],
    clips: [],
    tracks: [],
    sectionMarkers: [],
  } as unknown as SongView;
}

const sections = (draft: ArrangementDraft) => draft.blocks.map((b) => b.sectionMarkerId);

function handlersSpy() {
  return createStructureHandlers({
    runAction: async (work) => {
      await work();
    },
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
    t: (key) => key,
  });
}

describe("structure editor — C1: operations", () => {
  const base = draftForArrangement("r1", STRUCTURE.arrangements[0]);

  it("adds at the end and inserts where asked", () => {
    expect(sections(addBlock(base, "intro"))).toEqual(["intro", "verso", "coro", "coro", "intro"]);
    expect(sections(insertBlock(base, 1, "coro"))).toEqual(["intro", "coro", "verso", "coro", "coro"]);
    // Out of range clamps to the ends.
    expect(sections(insertBlock(base, 99, "intro")).at(-1)).toBe("intro");
    expect(sections(insertBlock(base, -3, "intro"))[0]).toBe("intro");
  });

  it("reorders, duplicates and removes by block id", () => {
    expect(sections(moveBlock(base, "b1", 3))).toEqual(["verso", "coro", "coro", "intro"]);
    expect(sections(moveBlock(base, "b4", 0))).toEqual(["coro", "intro", "verso", "coro"]);
    const duplicated = duplicateBlock(base, "b2");
    expect(sections(duplicated)).toEqual(["intro", "verso", "verso", "coro", "coro"]);
    expect(new Set(duplicated.blocks.map((b) => b.id)).size).toBe(5);
    expect(sections(removeBlock(base, "b3"))).toEqual(["intro", "verso", "coro"]);
    // Unknown ids change nothing.
    expect(moveBlock(base, "nope", 0)).toBe(base);
  });

  it("the drop gap maps to the index in the resulting list", () => {
    const ids = ["a", "b", "c", "d"];
    expect(targetIndexForGap(ids, "a", 3)).toBe(2); // tras la c
    expect(targetIndexForGap(ids, "d", 1)).toBe(1);
    expect(targetIndexForGap(ids, "b", 2)).toBe(1); // su propio hueco
  });

  it("opens on the applied arrangement, else the first, else a new one from the original", () => {
    expect(initialDraft("r1", STRUCTURE, (k) => k).draft.arrangementId).toBe("domingo");
    expect(
      initialDraft("r1", { ...STRUCTURE, appliedArrangementId: null }, (k) => k).draft.arrangementId,
    ).toBe("domingo");
    const fresh = initialDraft("r1", { ...STRUCTURE, arrangements: [] }, (k) => k);
    expect(fresh.draft.arrangementId).toBeNull();
    expect(sections(fresh.draft)).toEqual(["intro", "verso", "coro"]);
    expect(fresh.saved).toBeNull();
  });

  it("tracks unapplied changes and discarding them", () => {
    loadDraft(base, base);
    expect(isDraftDirty()).toBe(false);
    updateDraft((d) => addBlock(d, "intro"));
    expect(isDraftDirty()).toBe(true);
    // Switching arrangement = loading another draft; discard = load the saved.
    const corto = draftForArrangement("r1", STRUCTURE.arrangements[1]);
    loadDraft(corto, corto);
    expect(isDraftDirty()).toBe(false);
    expect(sections(useStructureStore.getState().draft!)).toEqual(["coro"]);
  });
});

describe("structure editor — panel", () => {
  /** C2: with an arrangement applied, the header indicator shows its name and
   * opens the panel. */
  it("the song header indicator shows the applied arrangement and opens the editor", async () => {
    useSongStore.setState({ song: songWith(STRUCTURE) });
    render(
      <>
        <ArrangementBadge region={region(STRUCTURE)} />
        <SongStructurePanel handlers={handlersSpy()} />
      </>,
    );
    const badge = screen.getByRole("button", {
      name: en.transport.structure.indicator.replace("{{name}}", "Domingo"),
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      fireEvent.click(badge);
    });

    const panel = await screen.findByRole("dialog", {
      name: en.transport.structure.panelTitle.replace("{{song}}", "Canción"),
    });
    expect(panel).toBeTruthy();
    // It opened on the applied arrangement, block by block.
    const strip = screen.getByRole("list", { name: en.transport.structure.strip });
    expect(strip.querySelectorAll("[data-block-id]")).toHaveLength(4);
  });

  it("the indicator is hidden without an applied arrangement", () => {
    render(<ArrangementBadge region={region({ ...STRUCTURE, appliedArrangementId: null })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("Delete and Ctrl+D edit the selected block without reaching the timeline", async () => {
    useSongStore.setState({ song: songWith(STRUCTURE) });
    openStructureEditor("r1");
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    render(<SongStructurePanel handlers={handlersSpy()} />);
    const strip = await screen.findByRole("list", { name: en.transport.structure.strip });
    await act(async () => {
      useStructureStore.setState({ selectedBlockId: "b2" });
    });

    await act(async () => {
      fireEvent.keyDown(strip, { key: "d", ctrlKey: true });
    });
    expect(sections(useStructureStore.getState().draft!)).toEqual([
      "intro",
      "verso",
      "verso",
      "coro",
      "coro",
    ]);
    await act(async () => {
      fireEvent.keyDown(strip, { key: "Delete" });
    });
    expect(sections(useStructureStore.getState().draft!)).toHaveLength(4);
    expect(windowKeys).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowKeys);
  });

  it("Apply saves and applies the working copy in one command", async () => {
    const desktopApi = await import("../desktopApi");
    const save = vi.spyOn(desktopApi, "saveSongArrangement").mockResolvedValue({
      snapshot: null as never,
      warnings: [],
      droppedBlocks: [],
    });
    useSongStore.setState({ song: songWith(STRUCTURE) });
    openStructureEditor("r1");
    render(<SongStructurePanel handlers={handlersSpy()} />);
    await screen.findByRole("list", { name: en.transport.structure.strip });
    await act(async () => {
      updateDraft((d) => addBlock(d, "intro"));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.transport.structure.apply }));
    });

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [regionId, arrangement, apply] = save.mock.calls[0];
    expect(regionId).toBe("r1");
    expect(apply).toBe(true);
    expect(arrangement.id).toBe("domingo");
    expect(arrangement.blocks.map((b) => b.sectionMarkerId)).toEqual([
      "intro",
      "verso",
      "coro",
      "coro",
      "intro",
    ]);
    expect(isDraftDirty()).toBe(false);
  });

  it("without an original it lists the detected sections and offers to save it", async () => {
    const desktopApi = await import("../desktopApi");
    const capture = vi.spyOn(desktopApi, "captureSongStructure").mockResolvedValue({
      snapshot: null as never,
      warnings: [],
      droppedBlocks: [],
    });
    useSongStore.setState({
      song: {
        ...songWith(undefined),
        sectionMarkers: [
          { id: "m1", name: "Intro", startSeconds: 0, kind: "intro" },
          { id: "m2", name: "Coro", startSeconds: 20, kind: "chorus" },
          { id: "m3", name: "Build", startSeconds: 30, kind: "build" },
        ],
      } as SongView,
    });
    openStructureEditor("r1");
    render(<SongStructurePanel handlers={handlersSpy()} />);
    expect(await screen.findByText("Intro")).toBeTruthy();
    expect(screen.getByText("Coro")).toBeTruthy();
    // A cue marker does not open a section.
    expect(screen.queryByText("Build")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.transport.structure.captureOriginal }));
    });
    expect(capture).toHaveBeenCalledWith("r1");
  });

  /** C3: capture warnings are shown and "snap to bar" moves the marker and
   * captures again. */
  it("shows capture warnings and snaps an off-beat section to the bar", async () => {
    const desktopApi = await import("../desktopApi");
    const update = vi.spyOn(desktopApi, "updateSectionMarker").mockResolvedValue(null as never);
    const capture = vi.spyOn(desktopApi, "captureSongStructure").mockResolvedValue({
      snapshot: null as never,
      warnings: [],
      droppedBlocks: [],
    });
    useSongStore.setState({ song: songWith(STRUCTURE) });
    openStructureEditor("r1");
    useStructureStore.setState({
      report: {
        regionId: "r1",
        warnings: [
          { kind: "offBeatSection", markerId: "verso", clipId: null, suggestedStartSeconds: 8 },
          { kind: "midiClipCrossesSection", markerId: "coro", clipId: "m1", suggestedStartSeconds: null },
        ],
        droppedBlocks: [],
      },
    });
    render(<SongStructurePanel handlers={handlersSpy()} />);

    expect(
      await screen.findByText(en.transport.structure.warnings.offBeat.replace("{{name}}", "Verso")),
    ).toBeTruthy();
    expect(
      screen.getByText(en.transport.structure.warnings.midiCrosses.replace("{{name}}", "Coro")),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.transport.structure.warnings.snapToBar }));
    });
    await waitFor(() => expect(capture).toHaveBeenCalledWith("r1"));
    expect(update).toHaveBeenCalledWith("verso", "Verso", 8);
  });
});

describe("structure editor — ruler and waveforms", () => {
  it("shades only the copy sections of songs with an applied arrangement", () => {
    expect(isCopyMarkerId("coro~2")).toBe(true);
    expect(isCopyMarkerId("coro")).toBe(false);
    expect(isCopyMarkerId("r1~start")).toBe(false);
    const markers = [
      { id: "coro", name: "Coro", startSeconds: 0, kind: "chorus" as const },
      { id: "build~2", name: "Build", startSeconds: 12, kind: "build" as const },
      { id: "coro~2", name: "Coro", startSeconds: 10, kind: "chorus" as const },
    ];
    expect(copySectionSpans(markers, [region(STRUCTURE)])).toEqual([
      { startSeconds: 10, endSeconds: 48 },
    ]);
    expect(copySectionSpans(markers, [region({ ...STRUCTURE, appliedArrangementId: null })])).toEqual([]);
  });

  /** C4: an arrangement with repeats adds clips but no new source: the
   * waveform loader does not ask for anything new (peaks are per file). */
  it("applying an arrangement with repeats requests no new waveform", async () => {
    const desktopApi = await import("../desktopApi");
    const request = vi.spyOn(desktopApi, "getWaveformSummaries").mockResolvedValue([]);
    const clip = (id: string, start: number, key: string) => ({
      id,
      trackId: "t",
      trackName: "t",
      filePath: key,
      waveformKey: key,
      isMissing: false,
      timelineStartSeconds: start,
      sourceStartSeconds: 0,
      sourceWindowDurationSeconds: 8,
      sourceDurationSeconds: 48,
      durationSeconds: 8,
      gain: 1,
    });
    const summary = (key: string) => ({
      waveformKey: key,
      version: 6,
      durationSeconds: 48,
      sampleRate: 48000,
      lods: [],
    });
    const original = {
      ...songWith(STRUCTURE),
      clips: [clip("v", 8, "audio/a.wav"), clip("c", 24, "audio/b.wav")],
      waveforms: [summary("audio/a.wav"), summary("audio/b.wav")],
    } as unknown as SongView;
    const arranged = {
      ...original,
      clips: [...original.clips, clip("v~2", 40, "audio/a.wav"), clip("c~2", 56, "audio/b.wav")],
    } as unknown as SongView;

    const { rerender } = renderHook(({ song }) => useSongWaveforms({ song, setWaveformCache: vi.fn() }), {
      initialProps: { song: original },
    });
    rerender({ song: arranged });
    await act(async () => {
      await Promise.resolve();
    });
    expect(request).not.toHaveBeenCalled();
  });
});
