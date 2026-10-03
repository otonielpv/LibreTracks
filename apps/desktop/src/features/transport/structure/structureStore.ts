import { create } from "zustand";

import type {
  DroppedArrangementBlocks,
  StructureWarning,
} from "@libretracks/shared/desktopApi";

/**
 * Song-arrangement UI state ("Arreglo"): the edit guard dialog and the block
 * editor's working copy.
 *
 * The editor edits a LOCAL copy of the arrangement: dragging blocks around
 * does not touch the timeline (rebuilding and pushing several songs per drag
 * would be costly and would flood the undo history). "Apply" saves and applies
 * it in a single backend command.
 *
 * A store survives unmounting, so it is reset in `src/test/testUtils.tsx`.
 */

/** Asked when an edit hits a song with an applied arrangement. */
export type StructureGuardRequest = {
  regionId: string;
  regionName: string;
  arrangementName: string;
};

/** One block of the arrangement being edited. `id` is stable while editing so
 * React keys and drag targets survive reordering. */
export type DraftBlock = {
  id: string;
  sectionMarkerId: string;
};

export type ArrangementDraft = {
  regionId: string;
  /** `null` while building a brand-new arrangement that was never saved. */
  arrangementId: string | null;
  name: string;
  blocks: DraftBlock[];
};

type StructureState = {
  guard: StructureGuardRequest | null;
  /** Song whose arrangement editor is open, or `null`. */
  editorRegionId: string | null;
  draft: ArrangementDraft | null;
  /** The saved version of `draft`, to tell whether there are unapplied
   * changes. */
  savedDraft: ArrangementDraft | null;
  selectedBlockId: string | null;
  /** What the last capture had to say (off-beat sections, MIDI crossing a
   * boundary, blocks dropped by a recapture). */
  report: {
    regionId: string;
    warnings: StructureWarning[];
    droppedBlocks: DroppedArrangementBlocks[];
  } | null;
};

export const INITIAL_STRUCTURE_STATE: StructureState = {
  guard: null,
  editorRegionId: null,
  draft: null,
  savedDraft: null,
  selectedBlockId: null,
  report: null,
};

export const useStructureStore = create<StructureState>()(() => ({
  ...INITIAL_STRUCTURE_STATE,
}));

export const openStructureGuard = (request: StructureGuardRequest) =>
  useStructureStore.setState({ guard: request });

export const closeStructureGuard = () =>
  useStructureStore.setState({ guard: null });

let blockIdCounter = 0;

/** A fresh id for a block created in the editor. */
export function nextDraftBlockId(): string {
  blockIdCounter += 1;
  return `block-${Date.now().toString(36)}-${blockIdCounter}`;
}

export function draftsEqual(
  left: ArrangementDraft | null,
  right: ArrangementDraft | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.regionId === right.regionId &&
    left.arrangementId === right.arrangementId &&
    left.name === right.name &&
    left.blocks.length === right.blocks.length &&
    left.blocks.every(
      (block, index) =>
        block.sectionMarkerId === right.blocks[index]?.sectionMarkerId,
    )
  );
}

/** Whether the open editor holds changes that were never applied. */
export function hasUnappliedChanges(state: StructureState): boolean {
  return state.draft !== null && !draftsEqual(state.draft, state.savedDraft);
}
