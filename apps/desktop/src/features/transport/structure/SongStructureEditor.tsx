import { useCallback, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import "./structure.css";

import type { StructureSectionSummary } from "./types";
import type { ArrangementDraft, DraftBlock } from "./structureStore";
import {
  addBlock,
  duplicateBlock,
  formatBars,
  insertBlock,
  moveBlock,
  removeBlock,
  sectionColor,
  sectionLabel,
  selectBlock,
  updateDraft,
} from "./structureEditor";
import { useBlockReorder } from "./useBlockReorder";

export type SongStructureEditorProps = {
  sections: StructureSectionSummary[];
  draft: ArrangementDraft;
  selectedBlockId: string | null;
  /** Desktop: a horizontal strip. Mobile: a vertical list, one row per block. */
  layout: "horizontal" | "vertical";
  /** Mobile puts the palette in a bottom sheet. */
  showPalette?: boolean;
  /** Mobile: only the handle starts a drag, so dragging the rest of a row
   * scrolls the list. */
  handleOnly?: boolean;
  /** Extra per-row content (the mobile swipe/long-press wrapper). */
  wrapBlock?: (block: DraftBlock, row: ReactNode) => ReactNode;
  /** Mobile: something to put in the gap BEFORE block `index` (the "insert
   * here" line). It lives inside the block's row so it moves with it. */
  renderGap?: (index: number) => ReactNode;
};

/**
 * The arrangement's block list, shared by the desktop panel and the mobile
 * screen. It edits the LOCAL working copy in the structure store; nothing
 * reaches the timeline until "Apply".
 */
export function SongStructureEditor({
  sections,
  draft,
  selectedBlockId,
  layout,
  showPalette = true,
  handleOnly = false,
  wrapBlock,
  renderGap,
}: SongStructureEditorProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLOListElement | null>(null);
  const sectionsById = useMemo(
    () => new Map(sections.map((section) => [section.markerId, section])),
    [sections],
  );

  const { onBlockPointerDown, onPalettePointerDown } = useBlockReorder({
    axis: layout === "horizontal" ? "x" : "y",
    listRef,
    onMove: (blockId, toIndex) => updateDraft((d) => moveBlock(d, blockId, toIndex)),
    onTap: (blockId) => selectBlock(blockId),
    onInsert: (index, sectionId) => updateDraft((d) => insertBlock(d, index, sectionId)),
    onAppend: (sectionId) => updateDraft((d) => addBlock(d, sectionId)),
  });

  const onListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!selectedBlockId) return;
      const duplicate = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d";
      const remove = event.key === "Delete" || event.key === "Backspace";
      if (!duplicate && !remove) return;
      // The timeline shortcuts listen on window: without this, Delete would
      // also delete the selected clip and Ctrl+D duplicate it.
      event.preventDefault();
      event.stopPropagation();
      if (duplicate) {
        updateDraft((d) => duplicateBlock(d, selectedBlockId));
      } else {
        const index = draft.blocks.findIndex((block) => block.id === selectedBlockId);
        updateDraft((d) => removeBlock(d, selectedBlockId));
        const next = draft.blocks[index + 1] ?? draft.blocks[index - 1];
        selectBlock(next && next.id !== selectedBlockId ? next.id : null);
      }
    },
    [draft.blocks, selectedBlockId],
  );

  const totalBars = draft.blocks.reduce(
    (sum, block) => sum + (sectionsById.get(block.sectionMarkerId)?.bars ?? 0),
    0,
  );

  return (
    <div className={`lt-structure-editor is-${layout}`}>
      {showPalette ? (
        <div className="lt-structure-palette" aria-label={t("transport.structure.palette")}>
          <div className="lt-structure-caption">
            <strong>{t("transport.structure.palette")}</strong>
            <span>{t("transport.structure.paletteHint")}</span>
          </div>
          <div className="lt-structure-chips" role="list">
            {sections.map((section) => (
              <button
                key={section.markerId}
                type="button"
                role="listitem"
                className="lt-structure-chip"
                style={{ ["--lt-structure-color" as string]: sectionColor(section) }}
                onPointerDown={(event) => onPalettePointerDown(event, section.markerId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    updateDraft((d) => addBlock(d, section.markerId));
                  }
                }}
                title={t("transport.structure.addSection")}
              >
                <span className="lt-structure-chip-name">{sectionLabel(section, t)}</span>
                <span className="lt-structure-chip-bars">{formatBars(section.bars, t)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="lt-structure-strip-wrap">
        <div className="lt-structure-caption">
          <strong>{t("transport.structure.strip")}</strong>
          {/* Supr y Ctrl+D no existen en una pantalla táctil: en móvil se
              explican los gestos. */}
          <span>
            {t(
              layout === "horizontal"
                ? "transport.structure.stripHint"
                : "transport.structure.stripHintTouch",
            )}
          </span>
          <span className="lt-structure-total">
            {t("transport.structure.totalBars", { count: Math.round(totalBars) })}
          </span>
        </div>
        <ol
          ref={listRef}
          className="lt-structure-strip"
          tabIndex={0}
          aria-label={t("transport.structure.strip")}
          onKeyDown={onListKeyDown}
        >
          {draft.blocks.length === 0 ? (
            <li className="lt-structure-empty">{t("transport.structure.emptyStrip")}</li>
          ) : null}
          {draft.blocks.map((block, index) => {
            const section = sectionsById.get(block.sectionMarkerId);
            const label = section ? sectionLabel(section, t) : block.sectionMarkerId;
            const row = (
              <div
                className={`lt-structure-block ${
                  selectedBlockId === block.id ? "is-selected" : ""
                }`}
                style={{
                  ["--lt-structure-color" as string]: section ? sectionColor(section) : undefined,
                }}
                onPointerDown={
                  handleOnly ? undefined : (event) => onBlockPointerDown(event, block.id)
                }
                onClick={handleOnly ? () => selectBlock(block.id) : undefined}
              >
                <span className="lt-structure-block-index">{index + 1}</span>
                <span className="lt-structure-block-name">{label}</span>
                {section ? (
                  <span className="lt-structure-block-bars">{formatBars(section.bars, t)}</span>
                ) : null}
                {handleOnly ? (
                  <span
                    className="lt-structure-handle material-symbols-outlined"
                    role="button"
                    aria-label={t("transport.structure.dragHandle")}
                    onPointerDown={(event) => onBlockPointerDown(event, block.id)}
                  >
                    drag_indicator
                  </span>
                ) : null}
              </div>
            );
            return (
              <li key={block.id} data-block-id={block.id} className="lt-structure-item">
                {renderGap ? renderGap(index) : null}
                {wrapBlock ? wrapBlock(block, row) : row}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
