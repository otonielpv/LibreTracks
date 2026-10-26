import type { MouseEvent as ReactMouseEvent } from "react";
import type { RulerMarkerRef, SongRegionSummary, SongView } from "../desktopApi";

import type { TimelineMenus } from "../menus/timelineMenus";
import type { RulerMarkerHandlers } from "../rulerMarkers/rulerMarkerHandlers";
import { groupContaining, handleRulerMarkerClick } from "../rulerMarkers/rulerMarkerSelection";
import { requestStructureEdit } from "../structure/structureGuard";
import { selectedRulerMarkers, useTimelineUIStore } from "../uiStore";
import {
  buildSongTempoRegions,
  getSongBaseBpm,
  getSongBaseTimeSignature,
} from "@libretracks/shared/models";
import { clampRegionResizeEdge, regionResizeBounds } from "../timeline/regionResize";
import { snapToTimelineBar } from "../timeline/timelineMath";
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
  menus: Pick<
    TimelineMenus,
    | "openMenu"
    | "rulerContextMenu"
    | "createTypedMarker"
    | "openCreateSectionKindMenu"
    | "openCreateCueKindMenu"
    | "songRegionContextMenu"
    | "tempoMarkerContextMenu"
    | "timeSignatureMarkerContextMenu"
    | "keyChangeCallbacks"
  >;
  rulerMarkers: Pick<RulerMarkerHandlers, "moveGroup" | "duplicate" | "remove" | "groupMenu">;
  onSectionContextMenu: (event: ReactMouseEvent<HTMLElement>, markerId: string) => void;
  /** The DAW region band's commit for new song edges. */
  onResizeSong: (regionId: string, startSeconds: number, endSeconds: number) => void;
  workspaceEndSeconds: number;
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

  /** The DAW ruler menu at a point of the song (create a section or a cue,
   * a tempo or meter change…): right click on the waveform. */
  function openMenuAt(event: ReactMouseEvent<HTMLElement>, seconds: number) {
    const deps = getDeps();
    const target = place(seconds);
    if (target === null || !requestStructureEdit([target])) return;
    deps.menus.openMenu(
      event,
      deps.t("transport.menu.createMarker"),
      deps.menus.rulerContextMenu(target, null),
    );
  }

  /** «+ Section at the playhead»: the same menu, at the playhead's bar (or
   * the song start when the playhead is elsewhere), opened at the button. */
  function createAtPlayhead(event: ReactMouseEvent<HTMLElement>) {
    const deps = getDeps();
    const region = deps.getRegion();
    if (!region) return;
    const playhead = deps.getPlayheadSeconds();
    const inside = playhead >= region.startSeconds && playhead < region.endSeconds;
    openMenuAt(event, inside ? playhead : region.startSeconds);
  }

  /**
   * The handle at the song's end: the length of its last section. Same walls
   * and audio floor as dragging the region's edge in the DAW
   * (timeline/regionResize), snapped to the bar when snapping is on.
   */
  function resizeSongEnd(endSeconds: number) {
    const deps = getDeps();
    const region = deps.getRegion();
    if (!region) return false;
    const song = deps.getSong();
    const snapped = deps.getSnapEnabled()
      ? snapToTimelineBar(
          endSeconds,
          getSongBaseBpm(song),
          getSongBaseTimeSignature(song),
          buildSongTempoRegions(song),
        )
      : endSeconds;
    const bounds = regionResizeBounds(song.regions, region, song.clips, deps.workspaceEndSeconds);
    const next = clampRegionResizeEdge("end", snapped, bounds);
    if (Math.abs(next - region.endSeconds) < 1e-6) return false;
    if (!requestStructureEdit([region.startSeconds])) return false;
    deps.onResizeSong(region.id, region.startSeconds, next);
    return true;
  }

  /** Double click / tap on the waveform: a marker there, on the bar. */
  function createAt(seconds: number) {
    const target = place(seconds);
    if (target === null || !requestStructureEdit([target])) return;
    getDeps().menus.createTypedMarker(target, null, null);
  }

  /** «+ Section here» / «+ Cue here»: the DAW's kind list (Verse, Chorus…
   * or All in, Drums…) at that bar; picking one creates it, named. */
  function createKindAt(seconds: number, lane: "section" | "cue") {
    const target = place(seconds);
    if (target === null || !requestStructureEdit([target])) return;
    const { menus } = getDeps();
    if (lane === "section") menus.openCreateSectionKindMenu(target);
    else menus.openCreateCueKindMenu(target);
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

  /** Tempo, meter and key changes at a point of the song, on a phone (no
   * ruler to right-click): the DAW's own actions, from the ruler menu (tempo,
   * meter, at the line's bar) and the song menu (a key change, at the
   * playhead, which the scrub view has just put on the line). */
  function openTimingMenuAt(event: ReactMouseEvent<HTMLElement>, seconds: number) {
    const deps = getDeps();
    const region = deps.getRegion();
    const target = place(seconds);
    if (!region || target === null) return;
    const label = (key: string) => deps.t(key);
    const ruler = deps.menus.rulerContextMenu(target, null);
    const actions = [
      ruler.find((action) => action.label === label("transport.menu.changeTimelineBpm")),
      ruler.find((action) => action.label === label("transport.menu.createTimeSignatureMarker")),
      deps.menus
        .songRegionContextMenu(region)
        .find((action) => action.label.startsWith(label("transport.keyChanges.addAtCursor"))),
    ].filter((action): action is NonNullable<typeof action> => Boolean(action));
    deps.menus.openMenu(event, deps.t("setlistView.sections.timingTitle"), actions);
  }

  /** A tempo, meter or key mark on the scrub view: its DAW menu. */
  function openTimingMarkMenu(
    event: ReactMouseEvent<HTMLElement>,
    mark: { kind: "tempo" | "meter" | "key"; id: string },
  ) {
    const deps = getDeps();
    const song = deps.getSong();
    if (mark.kind === "key") {
      const region = deps.getRegion();
      if (region) deps.menus.keyChangeCallbacks.openMenu(event.clientX, event.clientY, region.id, mark.id);
      return;
    }
    if (mark.kind === "tempo") {
      const marker = song.tempoMarkers.find((candidate) => candidate.id === mark.id);
      if (marker) deps.menus.openMenu(event, `${marker.bpm} BPM`, deps.menus.tempoMarkerContextMenu(marker));
      return;
    }
    const marker = song.timeSignatureMarkers.find((candidate) => candidate.id === mark.id);
    if (marker) deps.menus.openMenu(event, marker.signature, deps.menus.timeSignatureMarkerContextMenu(marker));
  }

  return {
    openTimingMenuAt,
    openTimingMarkMenu,
    openMenuAt,
    resizeSongEnd,
    createAtPlayhead,
    createAt,
    createKindAt,
    commitMove,
    select,
    dragGroup,
    duplicateSelection,
    deleteSelection,
    openMenu,
  };
}

export type SectionEditHandlers = ReturnType<typeof createSectionEditHandlers>;
