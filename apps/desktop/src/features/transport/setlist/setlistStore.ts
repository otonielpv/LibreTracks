import { create } from "zustand";

/** Tabs of the bottom console in `wide`/`medium`. */
export type SetlistBottomTab = "tracks" | "click" | "pads";
/** Right-hand tabs of the `short` layout (phone in landscape). */
export type SetlistShortTab = "song" | "mix" | "pads";
/** Which edit drawer is open; `null` = performance (not editing). */
export type SetlistEditMode =
  | null
  | "song"
  | "sections"
  | "arrangement"
  | "tracks";

export type SetlistState = {
  bottomTab: SetlistBottomTab;
  shortTab: SetlistShortTab;
  editMode: SetlistEditMode;
  /** Section selected in the song map while editing (a marker id). */
  selectedSectionId: string | null;
  /** Height the user dragged the mixer to; `null` = the layout's default. */
  mixerHeightPx: number | null;
  /** `medium`: the mixer folded to its bar (Master, Click, Guide). */
  mixerCollapsed: boolean;
};

export const INITIAL_SETLIST_STATE: SetlistState = {
  bottomTab: "tracks",
  shortTab: "song",
  editMode: null,
  selectedSectionId: null,
  mixerHeightPx: null,
  mixerCollapsed: false,
};

type SetlistActions = {
  setBottomTab: (tab: SetlistBottomTab) => void;
  setShortTab: (tab: SetlistShortTab) => void;
  setEditMode: (mode: SetlistEditMode) => void;
  setSelectedSectionId: (sectionId: string | null) => void;
  setMixerHeightPx: (heightPx: number | null) => void;
  setMixerCollapsed: (collapsed: boolean) => void;
};

/**
 * State that belongs to the Setlist view only. Selection of songs, tracks
 * and clips is NOT here: the view reuses the project selection the DAW and
 * Compacta already share. Reset in src/test/testUtils.tsx (a store outlives
 * the component).
 */
export const useSetlistStore = create<SetlistState & SetlistActions>()(
  (set) => ({
    ...INITIAL_SETLIST_STATE,
    setBottomTab: (bottomTab) => set({ bottomTab }),
    setShortTab: (shortTab) => set({ shortTab }),
    setEditMode: (editMode) => set({ editMode }),
    setSelectedSectionId: (selectedSectionId) => set({ selectedSectionId }),
    setMixerHeightPx: (mixerHeightPx) => set({ mixerHeightPx }),
    setMixerCollapsed: (mixerCollapsed) => set({ mixerCollapsed }),
  }),
);
