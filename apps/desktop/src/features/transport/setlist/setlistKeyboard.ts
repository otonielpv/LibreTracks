import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
  SectionMarkerSummary,
  SongRegionSummary,
  SongView,
} from "@libretracks/shared/models";

import { useNetworkPermissions } from "../../network/useNetworkPermissions";
import type { PerformanceBindings, SongViewBindings } from "../songs/songViewBindings";
import { useTimelineUIStore } from "../uiStore";
import { activateSetlistSong, jumpToSongMapBlock } from "./setlistActivation";
import { useSetlistStore } from "./setlistStore";
import {
  barSecondsAtFor,
  blockIdForMarker,
  buildSongMapBlocks,
  resolveActiveBlock,
} from "./songMapModel";

/**
 * Keyboard of the Setlist view in performance (plan setlist-view, paso 19),
 * Playback's "Live ReOrder": ←/→ move a cursor over the shown song's
 * sections, Enter jumps there (or plays the song with no cursor), ↑/↓ go to
 * the previous/next song as a tap on its card would.
 *
 * The keys live in the shortcut registry with `scope: "setlist"`; the
 * dispatcher (TimelineKeyboardShortcuts) asks `isSetlistKeyboardActive` and
 * runs SETLIST_SHORTCUT_HANDLERS. What the handlers need comes from the
 * mounted view through a bridge, so nothing here is a second copy of the
 * view's actions: songs and sections go through setlistActivation, the same
 * code the cards and the map run on a tap.
 */
export type SetlistKeyboardBridge = {
  regions: readonly SongRegionSummary[];
  shownRegion: SongRegionSummary | null;
  song: SongView;
  canControl: boolean;
  pendingMarkerId: string | null;
  positionSecondsRef: { readonly current: number };
  startLabel: string;
  onSelectRegion: (regionId: string) => void;
  onCueSong: (regionId: string) => void;
  onPlaySong: (regionId: string, regionName: string) => void;
  onMarkerAction: (marker: SectionMarkerSummary) => void;
  onCancelPendingJump: () => void;
};

let readBridge: (() => SetlistKeyboardBridge) | null = null;

/** Mounted by SetlistView; clears the cursor when the song or mode changes. */
export function useSetlistKeyboardBridge(
  view: Pick<SongViewBindings, "regions" | "onSelectRegion" | "onCueSong" | "onPlaySong"> & {
    shownRegion: SongRegionSummary | null;
    performance: PerformanceBindings;
  },
): void {
  const { t } = useTranslation();
  const { canControl } = useNetworkPermissions();
  const { performance } = view;
  useSetlistKeyboard({
    regions: view.regions,
    shownRegion: view.shownRegion,
    song: performance.song,
    canControl,
    pendingMarkerId: performance.pendingMarkerId,
    positionSecondsRef: performance.positionSecondsRef,
    startLabel: t("transport.structure.implicitStart"),
    onSelectRegion: view.onSelectRegion,
    onCueSong: view.onCueSong,
    onPlaySong: view.onPlaySong,
    onMarkerAction: performance.onMarkerAction,
    onCancelPendingJump: performance.onCancelPendingJump,
  });
}

/** The bridge itself, over plain values (tests mount this one). */
export function useSetlistKeyboard(current: SetlistKeyboardBridge): void {
  const ref = useRef(current);
  ref.current = current;
  useEffect(() => {
    const read = () => ref.current;
    readBridge = read;
    return () => {
      if (readBridge === read) readBridge = null;
    };
  }, []);
  const editMode = useSetlistStore((state) => state.editMode);
  const shownRegionId = current.shownRegion?.id ?? null;
  useEffect(() => {
    useSetlistStore.getState().setSectionCursorId(null);
  }, [shownRegionId, editMode]);
}

/** Setlist on screen and in performance: its scoped keys take over. */
export function isSetlistKeyboardActive(): boolean {
  return (
    readBridge !== null &&
    useTimelineUIStore.getState().viewMode === "setlist" &&
    useSetlistStore.getState().editMode === null
  );
}

/** Esc: drops the cursor first. True when there was one. */
export function clearSetlistSectionCursor(): boolean {
  if (!isSetlistKeyboardActive()) return false;
  const store = useSetlistStore.getState();
  if (store.sectionCursorId === null) return false;
  store.setSectionCursorId(null);
  return true;
}

function shownBlocks(bridge: SetlistKeyboardBridge) {
  if (!bridge.shownRegion) return [];
  return buildSongMapBlocks(
    bridge.shownRegion,
    bridge.song.sectionMarkers,
    barSecondsAtFor(bridge.song),
    { start: bridge.startLabel },
  ).blocks;
}

function moveSection(step: -1 | 1): void {
  const bridge = readBridge?.();
  if (!bridge) return;
  const blocks = shownBlocks(bridge);
  if (blocks.length === 0) return;
  const store = useSetlistStore.getState();
  let index = blocks.findIndex((block) => block.id === store.sectionCursorId);
  if (index < 0) {
    // No cursor yet: start next to what sounds, or at an end of the song.
    const { activeId } = resolveActiveBlock(blocks, bridge.positionSecondsRef.current);
    const activeIndex = blocks.findIndex((block) => block.id === activeId);
    index = activeIndex >= 0 ? activeIndex + step : step > 0 ? 0 : blocks.length - 1;
  } else {
    index += step;
  }
  index = Math.max(0, Math.min(blocks.length - 1, index));
  store.setSectionCursorId(blocks[index].id);
}

function moveSong(step: -1 | 1): void {
  const bridge = readBridge?.();
  if (!bridge || bridge.regions.length === 0) return;
  const ordered = [...bridge.regions].sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );
  const current = ordered.findIndex((region) => region.id === bridge.shownRegion?.id);
  const index = current < 0
    ? (step > 0 ? 0 : ordered.length - 1)
    : Math.max(0, Math.min(ordered.length - 1, current + step));
  if (index === current) return;
  activateSetlistSong(ordered[index].id, bridge);
}

function confirmJump(): void {
  const bridge = readBridge?.();
  if (!bridge?.shownRegion || !bridge.canControl) return;
  const store = useSetlistStore.getState();
  const blocks = shownBlocks(bridge);
  const block = blocks.find((candidate) => candidate.id === store.sectionCursorId);
  if (!block) {
    // No cursor: what Enter does on a focused card.
    bridge.onPlaySong(bridge.shownRegion.id, bridge.shownRegion.name);
    return;
  }
  store.setSectionCursorId(null);
  jumpToSongMapBlock(block, {
    region: bridge.shownRegion,
    pendingBlockId: blockIdForMarker(blocks, bridge.pendingMarkerId),
    onMarkerAction: bridge.onMarkerAction,
    onCancelPendingJump: bridge.onCancelPendingJump,
    onPlaySong: bridge.onPlaySong,
    onCueSong: bridge.onCueSong,
  });
}

/**
 * A focused control keeps the keys it uses itself: arrows on a slider or
 * input move it, and Enter on a button presses it unless the arrows already
 * put a cursor on a section (after a click the focus stays on that card or
 * ▶, and the user's intent with a cursor is the jump).
 */
export function focusedControlOwnsKey(binding: string, target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (binding.startsWith("Arrow")) {
    return target.tagName === "INPUT" || target.getAttribute("role") === "slider";
  }
  if (binding === "Enter") {
    if (useSetlistStore.getState().sectionCursorId !== null) return false;
    return (
      target.tagName === "BUTTON" ||
      target.tagName === "A" ||
      target.tagName === "SUMMARY" ||
      target.getAttribute("role") === "button"
    );
  }
  return false;
}

export const SETLIST_SHORTCUT_HANDLERS = {
  "setlist.previousSection": (event: KeyboardEvent) => {
    event.preventDefault();
    moveSection(-1);
  },
  "setlist.nextSection": (event: KeyboardEvent) => {
    event.preventDefault();
    moveSection(1);
  },
  "setlist.previousSong": (event: KeyboardEvent) => {
    event.preventDefault();
    moveSong(-1);
  },
  "setlist.nextSong": (event: KeyboardEvent) => {
    event.preventDefault();
    moveSong(1);
  },
  "setlist.confirmJump": (event: KeyboardEvent) => {
    event.preventDefault();
    if (!event.repeat) confirmJump();
  },
} as const;
