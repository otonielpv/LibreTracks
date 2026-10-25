import { create } from "zustand";

/** Tabs of the bottom console in `wide`/`medium`. */
export type SetlistBottomTab = "tracks" | "pads";
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
  /** Height the user dragged the mixer to; `null` = the layout's default. */
  mixerHeightPx: number | null;
  /** `medium`: the mixer folded to its bar (Master, Click, Guide). */
  mixerCollapsed: boolean;
};

export const INITIAL_SETLIST_STATE: SetlistState = {
  bottomTab: "tracks",
  shortTab: "song",
  editMode: null,
  mixerHeightPx: null,
  mixerCollapsed: false,
};

type SetlistActions = {
  setBottomTab: (tab: SetlistBottomTab) => void;
  setShortTab: (tab: SetlistShortTab) => void;
  setEditMode: (mode: SetlistEditMode) => void;
  setMixerHeightPx: (heightPx: number | null) => void;
  setMixerCollapsed: (collapsed: boolean) => void;
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
    setShortTab: (shortTab) => set({ shortTab }),
    setEditMode: (editMode) => set({ editMode }),
    setMixerHeightPx: (mixerHeightPx) => set({ mixerHeightPx }),
    setMixerCollapsed: (mixerCollapsed) => set({ mixerCollapsed }),
  }),
);
