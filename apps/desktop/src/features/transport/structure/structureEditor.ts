import type { ArrangementInput } from "@libretracks/shared/desktopApi";
import { markerColor } from "@libretracks/shared/models";

import type {
  ArrangementSummary,
  SongStructureSummary,
  StructureSectionSummary,
} from "./types";
import {
  draftsEqual,
  nextDraftBlockId,
  useStructureStore,
  type ArrangementDraft,
  type DraftBlock,
} from "./structureStore";

/**
 * Pure operations on the arrangement being edited, plus the thin store
 * actions the editor calls. Shared by the desktop panel and the mobile screen:
 * the layout changes, the logic does not.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Display name of a section ("Start" for the implicit one). */
export function sectionLabel(section: StructureSectionSummary, t: Translate): string {
  return section.implicit ? t("transport.structure.implicitStart") : section.name;
}

/** Chip colour: the marker's own, or its kind's palette. */
export function sectionColor(section: StructureSectionSummary): string {
  return markerColor({ kind: section.kind, color: section.color });
}

/** "8 bars" — whole numbers when the section is bar-aligned. */
export function formatBars(bars: number, t: Translate): string {
  const rounded = Math.abs(bars - Math.round(bars)) < 0.05 ? Math.round(bars) : Math.round(bars * 10) / 10;
  return t("transport.structure.bars", { count: rounded });
}

export function draftForArrangement(
  regionId: string,
  arrangement: ArrangementSummary,
): ArrangementDraft {
  return {
    regionId,
    arrangementId: arrangement.id,
    name: arrangement.name,
    blocks: arrangement.blocks.map((block) => ({
      id: block.id,
      sectionMarkerId: block.sectionMarkerId,
    })),
  };
}

/** A new, unsaved arrangement that starts as the original order — the usual
 * starting point is "the song as it is, with one change". */
export function draftFromOriginal(
  regionId: string,
  structure: SongStructureSummary,
  name: string,
): ArrangementDraft {
  return {
    regionId,
    arrangementId: null,
    name,
    blocks: structure.sections.map((section) => ({
      id: nextDraftBlockId(),
      sectionMarkerId: section.markerId,
    })),
  };
}

export function nextArrangementName(structure: SongStructureSummary, t: Translate): string {
  const taken = new Set(structure.arrangements.map((arrangement) => arrangement.name));
  for (let n = structure.arrangements.length + 1; ; n += 1) {
    const name = t("transport.structure.defaultName", { n });
    if (!taken.has(name)) return name;
  }
}

/** What the editor shows when it opens: the applied arrangement, else the
 * first saved one, else a new one from the original. */
export function initialDraft(
  regionId: string,
  structure: SongStructureSummary,
  t: Translate,
): { draft: ArrangementDraft; saved: ArrangementDraft | null } {
  const preferred =
    structure.arrangements.find((a) => a.id === structure.appliedArrangementId) ??
    structure.arrangements[0];
  if (preferred) {
    const draft = draftForArrangement(regionId, preferred);
    return { draft, saved: draft };
  }
  return {
    draft: draftFromOriginal(regionId, structure, nextArrangementName(structure, t)),
    saved: null,
  };
}

export function addBlock(draft: ArrangementDraft, sectionMarkerId: string): ArrangementDraft {
  return insertBlock(draft, draft.blocks.length, sectionMarkerId);
}

export function insertBlock(
  draft: ArrangementDraft,
  index: number,
  sectionMarkerId: string,
): ArrangementDraft {
  const at = Math.max(0, Math.min(index, draft.blocks.length));
  const blocks = [...draft.blocks];
  blocks.splice(at, 0, { id: nextDraftBlockId(), sectionMarkerId });
  return { ...draft, blocks };
}

/** Moves a block so it ends up at `toIndex` of the resulting list. */
export function moveBlock(
  draft: ArrangementDraft,
  blockId: string,
  toIndex: number,
): ArrangementDraft {
  const from = draft.blocks.findIndex((block) => block.id === blockId);
  if (from < 0) return draft;
  const blocks = [...draft.blocks];
  const [moved] = blocks.splice(from, 1);
  const at = Math.max(0, Math.min(toIndex, blocks.length));
  blocks.splice(at, 0, moved);
  return { ...draft, blocks };
}

export function duplicateBlock(draft: ArrangementDraft, blockId: string): ArrangementDraft {
  const index = draft.blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return draft;
  return insertBlock(draft, index + 1, draft.blocks[index].sectionMarkerId);
}

export function removeBlock(draft: ArrangementDraft, blockId: string): ArrangementDraft {
  return { ...draft, blocks: draft.blocks.filter((block) => block.id !== blockId) };
}

export function newArrangementId(): string {
  return `arr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function toArrangementInput(draft: ArrangementDraft, id: string): ArrangementInput {
  return {
    id,
    name: draft.name.trim() || id,
    blocks: draft.blocks.map((block: DraftBlock) => ({
      id: block.id,
      sectionMarkerId: block.sectionMarkerId,
    })),
  };
}

// ── Store actions ──────────────────────────────────────────────────────────

export function openStructureEditor(regionId: string) {
  useStructureStore.setState({
    editorRegionId: regionId,
    draft: null,
    savedDraft: null,
    selectedBlockId: null,
  });
}

export function closeStructureEditor() {
  useStructureStore.setState({
    editorRegionId: null,
    draft: null,
    savedDraft: null,
    selectedBlockId: null,
  });
}

export function loadDraft(draft: ArrangementDraft, saved: ArrangementDraft | null) {
  useStructureStore.setState({ draft, savedDraft: saved, selectedBlockId: null });
}

/** Edit the working copy. */
export function updateDraft(change: (draft: ArrangementDraft) => ArrangementDraft) {
  const { draft } = useStructureStore.getState();
  if (!draft) return;
  const next = change(draft);
  if (next !== draft) useStructureStore.setState({ draft: next });
}

export function selectBlock(blockId: string | null) {
  useStructureStore.setState({ selectedBlockId: blockId });
}

/** The working copy has just been saved (and maybe applied). */
export function markDraftSaved(arrangementId: string) {
  const { draft } = useStructureStore.getState();
  if (!draft) return;
  const saved = { ...draft, arrangementId };
  useStructureStore.setState({ draft: saved, savedDraft: saved });
}

export function isDraftDirty(): boolean {
  const { draft, savedDraft } = useStructureStore.getState();
  return draft !== null && !draftsEqual(draft, savedDraft);
}
