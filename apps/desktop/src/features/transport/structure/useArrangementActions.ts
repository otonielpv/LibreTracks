import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { confirmDialog, promptDialog } from "../../../shared/dialog/dialogService";
import { useSongStore } from "../songStore";
import {
  closeStructureEditor,
  draftForArrangement,
  draftFromOriginal,
  originalDraft,
  initialDraft,
  isDraftDirty,
  loadDraft,
  markDraftSaved,
  newArrangementId,
  nextArrangementName,
  toArrangementInput,
  updateDraft,
} from "./structureEditor";
import type { StructureHandlers } from "./structureHandlers";
import { draftsEqual, ORIGINAL_SELECTION, useStructureStore } from "./structureStore";

/** Ask before throwing away unapplied changes. Resolves `true` when it is fine
 * to go on. */
export async function confirmDiscardChanges(t: (key: string) => string): Promise<boolean> {
  if (!isDraftDirty()) return true;
  return confirmDialog(t("transport.structure.closeWithChanges"));
}

/**
 * Everything the arrangement editor does, for the desktop panel and the mobile
 * screen alike: which song, its working copy, and the actions on saved
 * arrangements.
 */
export function useArrangementActions(handlers: StructureHandlers) {
  const { t } = useTranslation();
  const regionId = useStructureStore((state) => state.editorRegionId);
  const draft = useStructureStore((state) => state.draft);
  const savedDraft = useStructureStore((state) => state.savedDraft);
  const selectedBlockId = useStructureStore((state) => state.selectedBlockId);
  const song = useSongStore((state) => state.song);
  const region = regionId
    ? song?.regions.find((candidate) => candidate.id === regionId) ?? null
    : null;
  const structure = region?.structure;

  // The song disappeared (deleted, another session): nothing to edit.
  useEffect(() => {
    if (regionId && song && !region) closeStructureEditor();
  }, [region, regionId, song]);

  // First open, or the original was just captured: start a working copy.
  useEffect(() => {
    if (!regionId || !structure || draft?.regionId === regionId) return;
    const { draft: initial, saved } = initialDraft(regionId, structure, t);
    loadDraft(initial, saved);
  }, [draft?.regionId, regionId, structure, t]);

  const dirty = draft !== null && !draftsEqual(draft, savedDraft);
  const appliedId = structure?.appliedArrangementId ?? null;
  // The original counts as applied when no arrangement is.
  const draftIsApplied = draft?.isOriginal
    ? appliedId === null
    : draft?.arrangementId != null && draft.arrangementId === appliedId;

  const close = async () => {
    if (await confirmDiscardChanges(t)) closeStructureEditor();
  };

  /** Saves and applies the working copy. Resolves with the outcome so the
   * mobile screen can close on success or show the error. */
  const apply = async (): Promise<{ ok: boolean; error: unknown }> => {
    if (!regionId || !draft || draft.blocks.length === 0) return { ok: false, error: null };
    if (draft.isOriginal) {
      // "Original" in the selector + Apply = put the song back as it was.
      return handlers.applyArrangement(regionId, null);
    }
    const id = draft.arrangementId ?? newArrangementId();
    const result = await handlers.saveArrangement(regionId, toArrangementInput(draft, id), true);
    if (result.ok) markDraftSaved(id);
    return result;
  };

  const switchTo = async (arrangementId: string) => {
    if (!regionId || !structure) return;
    if (arrangementId === ORIGINAL_SELECTION) {
      if (draft?.isOriginal) return;
      if (!(await confirmDiscardChanges(t))) return;
      const original = originalDraft(regionId, structure, t);
      loadDraft(original, original);
      return;
    }
    if (arrangementId === draft?.arrangementId && !draft?.isOriginal) return;
    if (!(await confirmDiscardChanges(t))) return;
    const arrangement = structure.arrangements.find((a) => a.id === arrangementId);
    if (arrangement) {
      const next = draftForArrangement(regionId, arrangement);
      loadDraft(next, next);
    }
  };

  const createNew = async () => {
    if (!regionId || !structure || !(await confirmDiscardChanges(t))) return;
    loadDraft(draftFromOriginal(regionId, structure, nextArrangementName(structure, t)), null);
  };

  const rename = async () => {
    if (!regionId || !draft || draft.isOriginal) return;
    const name = (await promptDialog(t("transport.structure.renamePrompt"), draft.name))?.trim();
    if (!name) return;
    updateDraft((d) => ({ ...d, name }));
    // A saved arrangement is renamed right away (it does not change the
    // timeline); the blocks keep their unapplied changes, if any.
    if (draft.arrangementId && savedDraft) {
      const { ok } = await handlers.saveArrangement(
        regionId,
        toArrangementInput({ ...savedDraft, name }, draft.arrangementId),
        false,
      );
      if (ok) {
        useStructureStore.setState((state) => ({
          savedDraft: state.savedDraft ? { ...state.savedDraft, name } : null,
        }));
      }
    }
  };

  const remove = async () => {
    if (!regionId || !draft?.arrangementId || draft.isOriginal || !structure) return;
    if (!(await confirmDialog(t("transport.structure.deleteConfirm", { name: draft.name })))) {
      return;
    }
    await handlers.deleteArrangement(regionId, draft.arrangementId);
    const original = originalDraft(regionId, structure, t);
    loadDraft(original, original);
  };

  /** "Save the original again", for when it was captured wrong. Only the
   * timeline showing the original can be captured: with an arrangement
   * applied, it first offers to go back to the original so the user can fix
   * it and then save it again. */
  const recaptureOriginal = async () => {
    if (!regionId || !structure) return;
    if (appliedId !== null) {
      if (await confirmDialog(t("transport.structure.recaptureNeedsOriginal"))) {
        await handlers.applyArrangement(regionId, null);
        const original = originalDraft(regionId, structure, t);
        loadDraft(original, original);
      }
      return;
    }
    if (!(await confirmDiscardChanges(t))) return;
    await handlers.captureOriginal(regionId);
    // The sections may have changed: start again from the new original.
    useStructureStore.setState({ draft: null, savedDraft: null });
  };

  return {
    t,
    regionId,
    region,
    structure,
    draft,
    selectedBlockId,
    dirty,
    appliedId,
    draftIsApplied,
    close,
    apply,
    switchTo,
    createNew,
    rename,
    remove,
    recaptureOriginal,
  };
}

export type ArrangementActions = ReturnType<typeof useArrangementActions>;
