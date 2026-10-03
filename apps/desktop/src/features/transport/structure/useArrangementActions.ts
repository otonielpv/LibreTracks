import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { confirmDialog, promptDialog } from "../../../shared/dialog/dialogService";
import { useSongStore } from "../songStore";
import {
  closeStructureEditor,
  draftForArrangement,
  draftFromOriginal,
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
import { draftsEqual, useStructureStore } from "./structureStore";

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
  const draftIsApplied = draft?.arrangementId != null && draft.arrangementId === appliedId;

  const close = async () => {
    if (await confirmDiscardChanges(t)) closeStructureEditor();
  };

  const apply = async () => {
    if (!regionId || !draft || draft.blocks.length === 0) return;
    const id = draft.arrangementId ?? newArrangementId();
    const ok = await handlers.saveArrangement(regionId, toArrangementInput(draft, id), true);
    if (ok) markDraftSaved(id);
  };

  const backToOriginal = async () => {
    if (regionId) await handlers.applyArrangement(regionId, null);
  };

  const switchTo = async (arrangementId: string) => {
    if (!regionId || !structure || arrangementId === draft?.arrangementId) return;
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
    if (!regionId || !draft) return;
    const name = (await promptDialog(t("transport.structure.renamePrompt"), draft.name))?.trim();
    if (!name) return;
    updateDraft((d) => ({ ...d, name }));
    // A saved arrangement is renamed right away (it does not change the
    // timeline); the blocks keep their unapplied changes, if any.
    if (draft.arrangementId && savedDraft) {
      const ok = await handlers.saveArrangement(
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
    if (!regionId || !draft?.arrangementId || !structure) return;
    if (!(await confirmDialog(t("transport.structure.deleteConfirm", { name: draft.name })))) {
      return;
    }
    await handlers.deleteArrangement(regionId, draft.arrangementId);
    loadDraft(draftFromOriginal(regionId, structure, nextArrangementName(structure, t)), null);
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
    backToOriginal,
    switchTo,
    createNew,
    rename,
    remove,
  };
}

export type ArrangementActions = ReturnType<typeof useArrangementActions>;
