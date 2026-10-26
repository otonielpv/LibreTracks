import { create } from "zustand";

/** Tabs of the bottom console in `wide`/`medium`. */
export type SetlistBottomTab = "tracks" | "pads";
/** `short` (phone), like Playback on an iPhone: under the songs, either the
 * console or the song's waveform, never both. */
export type SetlistShortPane = "mixer" | "song" | "lyrics";
/** Which edit drawer is open; `null` = performance (not editing). */
export type SetlistEditMode =
  | null
  | "song"
  | "sections"
  | "arrangement"
  | "tracks"
  | "lanes"
  | "automation"
  | "midi"
  | "lyrics";

export const LANES_MIN_ZOOM = 1;
export const LANES_MAX_ZOOM = 16;

export type SetlistState = {
  bottomTab: SetlistBottomTab;
  editMode: SetlistEditMode;
  /** Height the user dragged the mixer to; `null` = the layout's default. */
  mixerHeightPx: number | null;
  /** `medium`: the mixer folded to its bar (Master), so the waveform gets
   * the height. */
  mixerCollapsed: boolean;
  shortPane: SetlistShortPane;
  /** `short`: the console takes the whole view (the song row hides) so the
   * faders have travel. */
  mixerExpanded: boolean;
  /** wide/medium: the lyrics panel is shown (beside the band, or instead of
   * it). The phone uses `shortPane: "lyrics"`. */
  lyricsOpen: boolean;
  /** The band's zoom (1 = the whole song; more follows the playhead). */
  overviewZoom: number;
  /** Edit → Lanes: 1 fits the song in the width, up to 16. Not the DAW's
   * camera: that one stays where it was. */
  lanesZoom: number;
  /** Edit → Lanes: horizontal scroll inside the song, in px (clamped by the
   * time scale). */
  lanesScrollPx: number;
};

export const INITIAL_SETLIST_STATE: SetlistState = {
  bottomTab: "tracks",
  editMode: null,
  mixerHeightPx: null,
  mixerCollapsed: false,
  shortPane: "mixer",
  mixerExpanded: false,
  lyricsOpen: false,
  overviewZoom: 1,
  lanesZoom: 1,
  lanesScrollPx: 0,
};

type SetlistActions = {
  setBottomTab: (tab: SetlistBottomTab) => void;
  setEditMode: (mode: SetlistEditMode) => void;
  setMixerHeightPx: (heightPx: number | null) => void;
  setMixerCollapsed: (collapsed: boolean) => void;
  setShortPane: (pane: SetlistShortPane) => void;
  setMixerExpanded: (expanded: boolean) => void;
  setLyricsOpen: (open: boolean) => void;
  setOverviewZoom: (zoom: number) => void;
  setLanesZoom: (zoom: number) => void;
  setLanesScrollPx: (scrollPx: number) => void;
};

/**
 * State that belongs to the Setlist view only. Selection of songs, tracks,
 * clips and markers is NOT here: the view reuses the project selection the
 * DAW and Compacta already share. Reset in src/test/testUtils.tsx (a store outlives
 * the component).
 */
/** A mode that must be asked before it is left (Edit → Arrangement with
 * unapplied changes). One at a time: only the active mode registers. */
let editLeaveGuard: (() => Promise<boolean>) | null = null;

export function setEditLeaveGuard(guard: (() => Promise<boolean>) | null) {
  editLeaveGuard = guard;
}

/** Changes the edit mode (or leaves edit with `null`), asking the active
 * mode first. Every way out goes through here: tabs, Edit/Done, Esc, back. */
export async function requestEditMode(next: SetlistEditMode): Promise<void> {
  const current = useSetlistStore.getState().editMode;
  if (current === next) return;
  if (editLeaveGuard && !(await editLeaveGuard())) return;
  useSetlistStore.getState().setEditMode(next);
}

export const useSetlistStore = create<SetlistState & SetlistActions>()(
  (set) => ({
    ...INITIAL_SETLIST_STATE,
    setBottomTab: (bottomTab) => set({ bottomTab }),
    setEditMode: (editMode) => set({ editMode }),
    setMixerHeightPx: (mixerHeightPx) => set({ mixerHeightPx }),
    setMixerCollapsed: (mixerCollapsed) => set({ mixerCollapsed }),
    setShortPane: (shortPane) => set({ shortPane }),
    setMixerExpanded: (mixerExpanded) => set({ mixerExpanded }),
    setLyricsOpen: (lyricsOpen) => set({ lyricsOpen }),
    setOverviewZoom: (overviewZoom) => set({ overviewZoom: Math.max(1, Math.min(8, overviewZoom)) }),
    setLanesZoom: (lanesZoom) =>
      set({ lanesZoom: Math.max(LANES_MIN_ZOOM, Math.min(LANES_MAX_ZOOM, lanesZoom)) }),
    setLanesScrollPx: (lanesScrollPx) => set({ lanesScrollPx: Math.max(0, lanesScrollPx) }),
  }),
);
