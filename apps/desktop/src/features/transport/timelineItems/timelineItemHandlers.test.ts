import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";

const upsertMidiClip = vi.fn(async (clip: unknown) => ({ snapshotFor: clip }));
const upsertAutomationCue = vi.fn(async (cue: unknown) => ({ snapshotFor: cue }));
const deleteMidiClip = vi.fn(async (id: string) => ({ deleted: id }));
const deleteAutomationCue = vi.fn(async (id: string) => ({ deleted: id }));

vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...actual,
    upsertMidiClip: (clip: unknown) => upsertMidiClip(clip),
    upsertAutomationCue: (cue: unknown) => upsertAutomationCue(cue),
    deleteMidiClip: (id: string) => deleteMidiClip(id),
    deleteAutomationCue: (id: string) => deleteAutomationCue(id),
  };
});

import { useTimelineUIStore } from "../uiStore";
import { createTimelineItemHandlers, timelineItemsDuplicateOffset } from "./timelineItemHandlers";
import { handleTimelineItemClick, itemsForMenu } from "./timelineItemSelection";

// 120 bpm 4/4: a bar is 2 s.
const song = {
  bpm: 120,
  timeSignature: "4/4",
  regions: [],
  tempoMarkers: [],
  timeSignatureMarkers: [],
  midiClips: [
    {
      id: "lyric",
      trackId: "pp",
      timelineStartSeconds: 8,
      name: "Verse 2",
      color: "#ff0000",
      lead: { unit: "beats", count: 1 },
      events: [{ id: "e1", atSeconds: 0, channel: null, kind: { type: "programChange", program: 3 } }],
    },
    {
      id: "long",
      trackId: "lights",
      timelineStartSeconds: 20,
      name: "Sweep",
      events: [
        {
          id: "e1",
          atSeconds: 0,
          channel: null,
          kind: { type: "controlCurve", controller: 7, fromValue: 0, toValue: 127, durationSeconds: 3 },
        },
      ],
    },
  ],
  automationCues: [
    {
      id: "cue",
      name: "Mute",
      atSeconds: 4,
      enabled: true,
      maxRuns: 2,
      lead: { unit: "bars", count: 1 },
      actions: [{ type: "setTrackMute", trackId: "drums", muted: true }],
    },
  ],
} as unknown as SongView;

function handlers() {
  const deps = {
    getSong: () => song,
    runAction: async (action: () => Promise<void>) => action(),
    applyPlaybackSnapshot: vi.fn(),
    refreshSongView: vi.fn(async () => song),
    setStatus: vi.fn(),
    t: (key: string) => key,
  };
  return { deps, items: createTimelineItemHandlers(deps) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("timeline item duplicate", () => {
  beforeEach(() => {
    upsertMidiClip.mockClear();
    upsertAutomationCue.mockClear();
    deleteMidiClip.mockClear();
    deleteAutomationCue.mockClear();
    useTimelineUIStore.getState().clearSelection();
  });

  it("moves copies by the group's span rounded up to whole bars, at least one", () => {
    expect(timelineItemsDuplicateOffset(song, [{ start: 4, end: 4 }])).toBe(2);
    expect(timelineItemsDuplicateOffset(song, [{ start: 20, end: 23 }])).toBe(4);
    expect(timelineItemsDuplicateOffset(song, [{ start: 4, end: 4 }, { start: 8, end: 8 }])).toBe(4);
    expect(timelineItemsDuplicateOffset(null, [{ start: 4, end: 4 }])).toBe(0);
  });

  it("copies a MIDI clip a bar later with everything but its id", async () => {
    const { deps, items } = handlers();
    items.duplicate([{ kind: "midi", id: "lyric" }]);
    await flush();
    const copy = upsertMidiClip.mock.calls[0][0] as Record<string, unknown>;
    expect(copy).toMatchObject({
      trackId: "pp",
      timelineStartSeconds: 10,
      name: "Verse 2",
      color: "#ff0000",
      lead: { unit: "beats", count: 1 },
    });
    expect(copy.id).not.toBe("lyric");
    expect(deps.refreshSongView).toHaveBeenCalled();
    // The copy is what ends up selected, so Ctrl+D again chains.
    expect(useTimelineUIStore.getState().selectedTimelineItems).toEqual([
      { kind: "midi", id: copy.id },
    ]);
  });

  it("copies a cue keeping its actions, run limit and lead", async () => {
    const { items } = handlers();
    items.duplicate([{ kind: "cue", id: "cue" }]);
    await flush();
    const copy = upsertAutomationCue.mock.calls[0][0] as Record<string, unknown>;
    expect(copy).toMatchObject({
      atSeconds: 6,
      maxRuns: 2,
      lead: { unit: "bars", count: 1 },
      actions: [{ type: "setTrackMute", trackId: "drums", muted: true }],
    });
    expect(copy.id).not.toBe("cue");
  });

  it("Ctrl+D duplicates the Ctrl/Cmd+click selection and says no when empty", async () => {
    const { items } = handlers();
    expect(items.duplicateSelected()).toBe(false);
    const store = useTimelineUIStore.getState();
    store.toggleTimelineItemSelection({ kind: "midi", id: "lyric" });
    store.toggleTimelineItemSelection({ kind: "cue", id: "cue" });
    expect(items.duplicateSelected()).toBe(true);
    await flush();
    // One offset for the whole group: 4..8 spans 2 bars, so +4 s.
    expect(upsertAutomationCue.mock.calls[0][0]).toMatchObject({ atSeconds: 8 });
    expect(upsertMidiClip.mock.calls[0][0]).toMatchObject({ timelineStartSeconds: 12 });
  });

  it("copyTo drops one copy where it was dragged, onto another track too", async () => {
    const { items } = handlers();
    items.copyTo({ kind: "midi", id: "lyric" }, 15, "lights");
    await flush();
    expect(upsertMidiClip.mock.calls[0][0]).toMatchObject({
      trackId: "lights",
      timelineStartSeconds: 15,
    });
  });

  it("selecting an item drops other selections and toggles off on a second click", () => {
    const store = useTimelineUIStore.getState();
    store.setSelectedClipIds(["audio"]);
    store.toggleTimelineItemSelection({ kind: "cue", id: "cue" });
    expect(useTimelineUIStore.getState().selectedClipIds).toEqual([]);
    store.toggleTimelineItemSelection({ kind: "cue", id: "cue" });
    expect(useTimelineUIStore.getState().selectedTimelineItems).toEqual([]);
    store.toggleTimelineItemSelection({ kind: "midi", id: "lyric" });
    store.setSelectedClipIds(["audio"]);
    expect(useTimelineUIStore.getState().selectedTimelineItems).toEqual([]);
  });

  it("Supr deletes every selected item and clears the selection", async () => {
    const { items } = handlers();
    expect(items.deleteSelected()).toBe(false);
    const store = useTimelineUIStore.getState();
    store.toggleTimelineItemSelection({ kind: "midi", id: "lyric" });
    store.toggleTimelineItemSelection({ kind: "cue", id: "cue" });
    expect(items.deleteSelected()).toBe(true);
    await flush();
    expect(deleteMidiClip).toHaveBeenCalledWith("lyric");
    expect(deleteAutomationCue).toHaveBeenCalledWith("cue");
    expect(useTimelineUIStore.getState().selectedTimelineItems).toEqual([]);
  });

  it("Shift+click adds the range from the last pick (same track for MIDI)", () => {
    const withMore = {
      ...song,
      midiClips: [
        ...(song.midiClips ?? []),
        { ...song.midiClips![0], id: "mid", timelineStartSeconds: 12 },
        { ...song.midiClips![0], id: "late", timelineStartSeconds: 16 },
        { ...song.midiClips![0], id: "other-track", trackId: "x", timelineStartSeconds: 14 },
      ],
    } as SongView;
    expect(handleTimelineItemClick(withMore, { kind: "midi", id: "lyric" }, { additive: false, range: false })).toBe(false);
    handleTimelineItemClick(withMore, { kind: "midi", id: "lyric" }, { additive: true, range: false });
    handleTimelineItemClick(withMore, { kind: "midi", id: "late" }, { additive: false, range: true });
    expect(useTimelineUIStore.getState().selectedTimelineItems.map((item) => item.id).sort()).toEqual(
      ["late", "lyric", "mid"],
    );
  });

  it("a menu on a selected item acts on the whole selection, else on the item", () => {
    const store = useTimelineUIStore.getState();
    store.toggleTimelineItemSelection({ kind: "midi", id: "lyric" });
    store.toggleTimelineItemSelection({ kind: "cue", id: "cue" });
    expect(itemsForMenu({ kind: "cue", id: "cue" })).toHaveLength(2);
    expect(itemsForMenu({ kind: "midi", id: "long" })).toEqual([{ kind: "midi", id: "long" }]);
  });
});
