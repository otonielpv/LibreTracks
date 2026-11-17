import type { SongView } from "@libretracks/shared/models";

import { type TimelineItemRef, useTimelineUIStore } from "../uiStore";

/**
 * A click on a MIDI clip or cue with a modifier, the same grammar as the ruler
 * markers: Ctrl/Cmd adds or removes it, Shift adds everything from the last
 * item picked to this one (same kind; for MIDI, same track). Returns false for
 * a plain click, which then opens the editor as always.
 */
export function handleTimelineItemClick(
  song: SongView | null | undefined,
  item: TimelineItemRef,
  modifiers: { additive: boolean; range: boolean },
): boolean {
  const store = useTimelineUIStore.getState();
  if (modifiers.range) {
    const range = itemRange(song, store.timelineItemAnchor, item);
    if (range) {
      store.extendTimelineItemSelection(range);
    } else {
      store.toggleTimelineItemSelection(item);
    }
    return true;
  }
  if (modifiers.additive) {
    store.toggleTimelineItemSelection(item);
    return true;
  }
  return false;
}

/** Items of `to`'s kind between the anchor and `to` (inclusive), by time;
 * null when there is no usable anchor. */
export function itemRange(
  song: SongView | null | undefined,
  anchor: TimelineItemRef | null,
  to: TimelineItemRef,
): TimelineItemRef[] | null {
  if (!song || !anchor || anchor.kind !== to.kind) return null;
  if (to.kind === "midi") {
    const clips = song.midiClips ?? [];
    const from = clips.find((clip) => clip.id === anchor.id);
    const target = clips.find((clip) => clip.id === to.id);
    if (!from || !target || from.trackId !== target.trackId) return null;
    const low = Math.min(from.timelineStartSeconds, target.timelineStartSeconds);
    const high = Math.max(from.timelineStartSeconds, target.timelineStartSeconds);
    return clips
      .filter(
        (clip) =>
          clip.trackId === target.trackId &&
          clip.timelineStartSeconds >= low - 1e-6 &&
          clip.timelineStartSeconds <= high + 1e-6,
      )
      .map((clip) => ({ kind: "midi", id: clip.id }));
  }
  const cues = song.automationCues ?? [];
  const from = cues.find((cue) => cue.id === anchor.id);
  const target = cues.find((cue) => cue.id === to.id);
  if (!from || !target) return null;
  const low = Math.min(from.atSeconds, target.atSeconds);
  const high = Math.max(from.atSeconds, target.atSeconds);
  return cues
    .filter((cue) => cue.atSeconds >= low - 1e-6 && cue.atSeconds <= high + 1e-6)
    .map((cue) => ({ kind: "cue", id: cue.id }));
}

/** What a context-menu action on `item` acts on: the whole selection when the
 * item is part of it, else just the item. */
export function itemsForMenu(item: TimelineItemRef): TimelineItemRef[] {
  const selected = useTimelineUIStore.getState().selectedTimelineItems;
  return selected.some((entry) => entry.kind === item.kind && entry.id === item.id)
    ? selected
    : [item];
}
