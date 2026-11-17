import type {
  AutomationCueSummary,
  MidiClipSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  deleteAutomationCue,
  deleteMidiClip,
  getSongTempoRegionAtPosition,
  upsertAutomationCue,
  upsertMidiClip,
} from "../desktopApi";
import { getBeatDurationSeconds, parseTimeSignature } from "../timeline/timelineMath";
import { nextClipId } from "../midi/midiClipHandlers";
import { type TimelineItemRef, useTimelineUIStore } from "../uiStore";

/** Same shape as `createAutomationCueId` in timelineMenus, which this module
 * cannot import (timelineMenus imports the menus that import this). */
function nextCueId() {
  return `automation_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Duplicate and copy MIDI clips and automation cues (issue #7): Ctrl/Cmd+D on
 * a Ctrl/Cmd+click selection, "Duplicate" in their menus, and Alt/Option+drag.
 * Both kinds are "fire these at this point" items with no audio, so one
 * implementation serves them, in the DAW and in the Setlist.
 */
export type TimelineItemHandlerDeps = {
  getSong: () => SongView | null;
  runAction: (action: () => Promise<void>) => Promise<void> | void;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSongView: (options: { sync: boolean }) => Promise<unknown>;
  setStatus: (status: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

type ResolvedItem =
  | { kind: "midi"; clip: MidiClipSummary }
  | { kind: "cue"; cue: AutomationCueSummary };

/** Where the clip's contents end: its longest event (0 for a bare bundle). */
export function midiClipExtentSeconds(clip: MidiClipSummary): number {
  let extent = 0;
  for (const event of clip.events ?? []) {
    const duration =
      event.kind.type === "note" || event.kind.type === "controlCurve"
        ? Math.max(0, event.kind.durationSeconds)
        : 0;
    extent = Math.max(extent, Math.max(0, event.atSeconds) + duration);
  }
  return extent;
}

/** A cue lasts as long as its waits (its actions run in sequence). */
export function cueExtentSeconds(cue: AutomationCueSummary): number {
  return (cue.actions ?? []).reduce(
    (total, action) =>
      action.type === "wait" ? total + Math.max(0, action.durationSeconds) : total,
    0,
  );
}

function itemStart(item: ResolvedItem): number {
  return item.kind === "midi" ? item.clip.timelineStartSeconds : item.cue.atSeconds;
}

function itemEnd(item: ResolvedItem): number {
  return item.kind === "midi"
    ? item.clip.timelineStartSeconds + midiClipExtentSeconds(item.clip)
    : item.cue.atSeconds + cueExtentSeconds(item.cue);
}

/** One bar at `seconds`, with the tempo and signature that rule there (as the
 * ruler markers' duplicate). */
function barSecondsAt(song: SongView, seconds: number): number {
  const region = getSongTempoRegionAtPosition(song, seconds);
  const bpm = region?.bpm ?? song.bpm;
  const timeSignature = region?.timeSignature ?? song.timeSignature;
  return (
    getBeatDurationSeconds(bpm, timeSignature) * parseTimeSignature(timeSignature).beatsPerBar
  );
}

/**
 * How far copies move on Duplicate: what the group spans (first start to last
 * end) rounded UP to whole bars, at least one bar. A lone instant cue lands a
 * bar later; a two-bar clip lands right after itself. Same idea as the ruler
 * markers' Ctrl+D (`duplicateOffsetSeconds`).
 */
export function timelineItemsDuplicateOffset(
  song: SongView | null,
  spans: Array<{ start: number; end: number }>,
): number {
  if (!song || spans.length === 0) return 0;
  const first = Math.min(...spans.map((span) => span.start));
  const last = Math.max(...spans.map((span) => span.end));
  const bar = barSecondsAt(song, first);
  if (!(bar > 0)) return 0;
  const bars = Math.max(1, Math.ceil((last - first) / bar - 1e-6));
  return bars * bar;
}

function resolve(song: SongView | null, items: TimelineItemRef[]): ResolvedItem[] {
  if (!song) return [];
  const resolved: ResolvedItem[] = [];
  for (const item of items) {
    if (item.kind === "midi") {
      const clip = song.midiClips?.find((candidate) => candidate.id === item.id);
      if (clip) resolved.push({ kind: "midi", clip });
    } else {
      const cue = song.automationCues?.find((candidate) => candidate.id === item.id);
      if (cue) resolved.push({ kind: "cue", cue });
    }
  }
  return resolved;
}

export function createTimelineItemHandlers(deps: TimelineItemHandlerDeps) {
  const { getSong, runAction, applyPlaybackSnapshot, refreshSongView, setStatus, t } = deps;

  /**
   * Write one copy of each item, `deltaSeconds` later (and, for a single MIDI
   * clip, onto `targetTrackId`). The copy keeps everything else: name,
   * events/actions, colour, lead time, run limit. The copies end up selected,
   * so a repeated Ctrl+D keeps chaining instead of stacking on the first.
   */
  const copyItems = (
    items: TimelineItemRef[],
    deltaSeconds: number,
    targetTrackId: string | null = null,
  ) => {
    const resolved = resolve(getSong(), items);
    if (resolved.length === 0) return;
    void runAction(async () => {
      const created: TimelineItemRef[] = [];
      let snapshot: TransportSnapshot | null = null;
      for (const item of resolved) {
        if (item.kind === "midi") {
          const id = nextClipId();
          snapshot = await upsertMidiClip({
            ...item.clip,
            id,
            trackId: (resolved.length === 1 && targetTrackId) || item.clip.trackId,
            timelineStartSeconds: Math.max(0, item.clip.timelineStartSeconds + deltaSeconds),
          });
          created.push({ kind: "midi", id });
        } else {
          const id = nextCueId();
          snapshot = await upsertAutomationCue({
            ...item.cue,
            id,
            atSeconds: Math.max(0, item.cue.atSeconds + deltaSeconds),
          });
          created.push({ kind: "cue", id });
        }
      }
      applyPlaybackSnapshot(snapshot);
      await refreshSongView({ sync: true });
      useTimelineUIStore.getState().setSelectedTimelineItems(created);
      setStatus(t("transport.timelineItems.statusDuplicated", { count: created.length }));
    });
  };

  /** Duplicate: copies right after the group (see the offset rule). */
  const duplicate = (items: TimelineItemRef[]) => {
    const song = getSong();
    const resolved = resolve(song, items);
    const offset = timelineItemsDuplicateOffset(
      song,
      resolved.map((item) => ({ start: itemStart(item), end: itemEnd(item) })),
    );
    if (offset <= 0) return;
    copyItems(items, offset);
  };

  /** Ctrl/Cmd+D: duplicate the Ctrl/Cmd+click selection. False when empty. */
  const duplicateSelected = (): boolean => {
    const items = useTimelineUIStore.getState().selectedTimelineItems;
    if (items.length === 0) return false;
    duplicate(items);
    return true;
  };

  /** Alt/Option+drag: drop a copy where the item was dragged to. */
  const copyTo = (item: TimelineItemRef, atSeconds: number, targetTrackId: string | null = null) => {
    const [resolved] = resolve(getSong(), [item]);
    if (!resolved) return;
    copyItems([item], atSeconds - itemStart(resolved), targetTrackId);
  };

  /** Supr: delete the Ctrl/Cmd+click selection. False when empty. */
  const deleteSelected = (): boolean => {
    const items = useTimelineUIStore.getState().selectedTimelineItems;
    if (items.length === 0) return false;
    deleteItems(items);
    return true;
  };

  /** Delete these items (the menu's "Delete" on a selection, or Supr). */
  const deleteItems = (items: TimelineItemRef[]) => {
    const resolved = resolve(getSong(), items);
    if (resolved.length === 0) return;
    void runAction(async () => {
      let snapshot: TransportSnapshot | null = null;
      for (const item of resolved) {
        snapshot =
          item.kind === "midi"
            ? await deleteMidiClip(item.clip.id)
            : await deleteAutomationCue(item.cue.id);
      }
      if (snapshot) applyPlaybackSnapshot(snapshot);
      await refreshSongView({ sync: true });
      useTimelineUIStore.getState().clearSelection();
      setStatus(t("transport.timelineItems.statusDeleted", { count: resolved.length }));
    });
  };

  return { duplicate, duplicateSelected, deleteSelected, deleteItems, copyTo };
}

export type TimelineItemHandlers = ReturnType<typeof createTimelineItemHandlers>;
