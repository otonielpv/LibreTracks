import type { MouseEvent as ReactMouseEvent } from "react";
import type { RulerMarkerRef, SongRegionSummary, SongView } from "../desktopApi";

import type { TimelineMenus } from "../menus/timelineMenus";
import type { RulerMarkerHandlers } from "../rulerMarkers/rulerMarkerHandlers";
import { groupContaining, handleRulerMarkerClick } from "../rulerMarkers/rulerMarkerSelection";
import { requestStructureEdit } from "../structure/structureGuard";
import { selectedRulerMarkers, useTimelineUIStore } from "../uiStore";
import { placeSectionSeconds } from "./sectionEditModel";

/**
 * Section editing on the Setlist waveform (Edit → Sections). Every action is
 * the DAW's: creating goes through the ruler menu / `createTypedMarker`,
 * moving, duplicating and deleting through the ruler marker handlers
 * (`moveRulerMarkers`, `duplicateRulerMarkers`, `deleteRulerMarkers`), the
 * menu is the section menu, and the selection is the project's marker
 * selection. Everything that edits asks the arrangement guard first.
 *
 * Created once; the volatile state comes through `getDeps` on every call.
 */
export type SectionEditDeps = {
  t: (key: string, options?: Record<string, unknown>) => string;
  getSong: () => SongView;
  getRegion: () => SongRegionSummary | null;
  getPlayheadSeconds: () => number;
  getSnapEnabled: () => boolean;
  menus: Pick<TimelineMenus, "openMenu" | "rulerContextMenu" | "createTypedMarker">;
  rulerMarkers: Pick<RulerMarkerHandlers, "moveGroup" | "duplicate" | "remove" | "groupMenu">;
  onSectionContextMenu: (event: ReactMouseEvent<HTMLElement>, markerId: string) => void;
};

const sectionRef = (id: string): RulerMarkerRef => ({ kind: "section", id });

export function createSectionEditHandlers(getDeps: () => SectionEditDeps) {
  const place = (seconds: number) => {
    const deps = getDeps();
    const region = deps.getRegion();
    return region
      ? placeSectionSeconds(deps.getSong(), region, seconds, deps.getSnapEnabled())
      : null;
  };

  /** «+ Section at the playhead»: the DAW ruler menu at that point (create
   * a typed marker, a cue, a tempo or meter change…), opened at the button. */
  function createAtPlayhead(event: ReactMouseEvent<HTMLElement>) {
    const deps = getDeps();
    const region = deps.getRegion();
    if (!region) return;
    const playhead = deps.getPlayheadSeconds();
    const inside = playhead >= region.startSeconds && playhead < region.endSeconds;
    const seconds = place(inside ? playhead : region.startSeconds);
    if (seconds === null || !requestStructureEdit([seconds])) return;
    deps.menus.openMenu(
      event,
      deps.t("transport.menu.createMarker"),
      deps.menus.rulerContextMenu(seconds, null),
    );
  }

  /** Double click / tap on the waveform: a marker there, on the bar. */
  function createAt(seconds: number) {
    const target = place(seconds);
    if (target === null || !requestStructureEdit([target])) return;
    getDeps().menus.createTypedMarker(target, null, null);
  }

  /** One commit when the drag ends: `moveRulerMarkers` for the group. */
  function commitMove(markerIds: readonly string[], deltaSeconds: number) {
    if (markerIds.length === 0 || Math.abs(deltaSeconds) < 1e-6) return false;
    const song = getDeps().getSong();
    const starts = markerIds
      .map((id) => song.sectionMarkers.find((marker) => marker.id === id)?.startSeconds)
      .filter((value): value is number => value !== undefined);
    if (!requestStructureEdit(starts)) return false;
    getDeps().rulerMarkers.moveGroup(markerIds.map(sectionRef), deltaSeconds);
    return true;
  }

  /** Click on a handle: select; Ctrl/⌘ adds, Shift extends (desktop). */
  function select(markerId: string, modifiers: { additive: boolean; range: boolean }) {
    const marker = sectionRef(markerId);
    if (handleRulerMarkerClick(getDeps().getSong(), marker, modifiers)) return;
    useTimelineUIStore.getState().setSelectedMarkers([marker], marker);
  }

  /** What a drag on this handle moves: the selection if it is part of it,
   * otherwise just this marker. */
  function dragGroup(markerId: string): string[] {
    const group = groupContaining(sectionRef(markerId));
    return group
      ? group.filter((marker) => marker.kind === "section").map((marker) => marker.id)
      : [markerId];
  }

  const selection = () => selectedRulerMarkers(useTimelineUIStore.getState());

  function duplicateSelection() {
    const markers = selection();
    if (markers.length === 0) return;
    const song = getDeps().getSong();
    const starts = markers
      .map((marker) => song.sectionMarkers.find((entry) => entry.id === marker.id)?.startSeconds)
      .filter((value): value is number => value !== undefined);
    if (!requestStructureEdit(starts)) return;
    getDeps().rulerMarkers.duplicate(markers);
  }

  function deleteSelection() {
    const markers = selection();
    if (markers.length === 0) return;
    const song = getDeps().getSong();
    const starts = markers
      .map((marker) => song.sectionMarkers.find((entry) => entry.id === marker.id)?.startSeconds)
      .filter((value): value is number => value !== undefined);
    if (!requestStructureEdit(starts)) return;
    getDeps().rulerMarkers.remove(markers);
  }

  /** A handle's menu: the group menu when it is part of a multiple
   * selection (like the DAW ruler), otherwise the section menu. */
  function openMenu(event: ReactMouseEvent<HTMLElement>, markerId: string) {
    const deps = getDeps();
    const group = groupContaining(sectionRef(markerId));
    if (group) {
      deps.menus.openMenu(
        event,
        deps.t("transport.menu.markersTitle", { count: group.length }),
        deps.rulerMarkers.groupMenu(group),
      );
      return;
    }
    deps.onSectionContextMenu(event, markerId);
  }

  return {
    createAtPlayhead,
    createAt,
    commitMove,
    select,
    dragGroup,
    duplicateSelection,
    deleteSelection,
    openMenu,
  };
}

export type SectionEditHandlers = ReturnType<typeof createSectionEditHandlers>;
