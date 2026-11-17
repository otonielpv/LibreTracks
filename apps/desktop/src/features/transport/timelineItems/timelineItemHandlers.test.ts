import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";

const upsertMidiClip = vi.fn(async (clip: unknown) => ({ snapshotFor: clip }));
const upsertAutomationCue = vi.fn(async (cue: unknown) => ({ snapshotFor: cue }));

vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...actual,
    upsertMidiClip: (clip: unknown) => upsertMidiClip(clip),
    upsertAutomationCue: (cue: unknown) => upsertAutomationCue(cue),
  };
});

import { useTimelineUIStore } from "../uiStore";
import { createTimelineItemHandlers, timelineItemsDuplicateOffset } from "./timelineItemHandlers";

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
});
