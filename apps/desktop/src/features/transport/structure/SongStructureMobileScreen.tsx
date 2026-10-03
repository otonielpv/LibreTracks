import { useCallback, useEffect, useRef, useState } from "react";

import { useDismissOnBack } from "../mobile/backNavigation";
import { ArrangementSelect } from "./ArrangementSelect";
import { SongStructureEditor } from "./SongStructureEditor";
import { StructureCapture, StructureWarnings } from "./StructureSections";
import { SwipeableRow } from "./SwipeableRow";
import {
  addBlock,
  duplicateBlock,
  formatBars,
  removeBlock,
  sectionColor,
  sectionLabel,
  updateDraft,
} from "./structureEditor";
import type { StructureHandlers } from "./structureHandlers";
import { useStructureStore, type ArrangementDraft } from "./structureStore";
import type { StructureSectionSummary } from "./types";
import type { ArrangementActions } from "./useArrangementActions";

import "./structure.css";

/** How long "Removed «Verse» · Undo" stays on screen. */
export const UNDO_TOAST_MS = 4000;

/** Landscape tablet: palette on the left, list on the right, no sheet. */
const WIDE_QUERY = "(min-width: 900px) and (orientation: landscape)";

function useWideLayout(): boolean {
  const query = () =>
    typeof window.matchMedia === "function" && window.matchMedia(WIDE_QUERY).matches;
  const [wide, setWide] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return () => {};
    const media = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(media.matches);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);
  return wide;
}

/** Tap-to-add palette (mobile has no drag-to-insert: the sheet would cover
 * the list). */
function TapPalette({
  sections,
  t,
}: {
  sections: StructureSectionSummary[];
  t: ArrangementActions["t"];
}) {
  return (
    <div className="lt-structure-chips is-tap" role="list" aria-label={t("transport.structure.palette")}>
      {sections.map((section) => (
        <button
          key={section.markerId}
          type="button"
          role="listitem"
          className="lt-structure-chip"
          style={{ ["--lt-structure-color" as string]: sectionColor(section) }}
          onClick={() => updateDraft((d) => addBlock(d, section.markerId))}
        >
          <span className="lt-structure-chip-name">{sectionLabel(section, t)}</span>
          <span className="lt-structure-chip-bars">{formatBars(section.bars, t)}</span>
        </button>
      ))}
    </div>
  );
}

/** Bottom sheet with the palette. A tap adds at the end and the sheet stays
 * open, so several sections can be added in a row. */
function PaletteSheet({
  sections,
  t,
  onClose,
}: {
  sections: StructureSectionSummary[];
  t: ArrangementActions["t"];
  onClose: () => void;
}) {
  useDismissOnBack(onClose);
  return (
    <div className="lt-structure-sheet-backdrop" onClick={onClose}>
      <section
        className="lt-structure-sheet"
        role="dialog"
        aria-label={t("transport.structure.addSection")}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{t("transport.structure.addSection")}</strong>
          <button type="button" className="lt-structure-touch" onClick={onClose}>
            {t("transport.structure.close")}
          </button>
        </header>
        <TapPalette sections={sections} t={t} />
      </section>
    </div>
  );
}

/** Long-press menu of a block. */
function BlockMenu({
  title,
  t,
  onDuplicate,
  onRemove,
  onClose,
}: {
  title: string;
  t: ArrangementActions["t"];
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  useDismissOnBack(onClose);
  return (
    <div className="lt-structure-sheet-backdrop" onClick={onClose}>
      <section
        className="lt-structure-sheet is-menu"
        role="menu"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{title}</strong>
        </header>
        <button type="button" role="menuitem" className="lt-structure-touch" onClick={onDuplicate}>
          {t("transport.structure.duplicateBlock")}
        </button>
        <button
          type="button"
          role="menuitem"
          className="lt-structure-touch is-destructive"
          onClick={onRemove}
        >
          {t("transport.structure.removeBlock")}
        </button>
      </section>
    </div>
  );
}

/**
 * Arrangement editor on phones and tablets: a full screen with the blocks as
 * a vertical list. Drag by the handle to reorder, swipe left to remove (with
 * undo), long-press for Duplicate/Remove, "+" for the palette. Android's back
 * button closes the topmost thing, and closing with unapplied changes asks.
 */
export function SongStructureMobileScreen({
  actions,
  handlers,
}: {
  actions: ArrangementActions;
  handlers: StructureHandlers;
}) {
  const { t, regionId, region, structure, draft, selectedBlockId, dirty, appliedId, draftIsApplied } =
    actions;
  const wide = useWideLayout();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuBlockId, setMenuBlockId] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ draft: ArrangementDraft; name: string } | null>(null);
  const undoTimer = useRef<number | null>(null);

  // Stable callback: `useDismissOnBack` re-registers a changed callback, and
  // re-registering puts the entry back on top of the stack — above a sheet
  // opened later, which must close first.
  const closeRef = useRef(actions.close);
  closeRef.current = actions.close;
  const onBack = useCallback(() => void closeRef.current(), []);
  useDismissOnBack(onBack);

  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  const nameOf = useCallback(
    (sectionMarkerId: string) => {
      const section = structure?.sections.find((s) => s.markerId === sectionMarkerId);
      return section ? sectionLabel(section, t) : sectionMarkerId;
    },
    [structure, t],
  );

  const removeWithUndo = (blockId: string) => {
    const before = useStructureStore.getState().draft;
    const block = before?.blocks.find((b) => b.id === blockId);
    if (!before || !block) return;
    updateDraft((d) => removeBlock(d, blockId));
    setUndo({ draft: before, name: nameOf(block.sectionMarkerId) });
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => {
      setUndo(null);
      undoTimer.current = null;
    }, UNDO_TOAST_MS);
  };

  const undoRemove = () => {
    if (!undo) return;
    useStructureStore.setState({ draft: undo.draft });
    setUndo(null);
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
  };

  if (!regionId || !region) return null;
  const menuBlock = draft?.blocks.find((block) => block.id === menuBlockId) ?? null;

  return (
    <div
      className={`lt-structure-mobile ${wide ? "is-wide" : ""}`}
      role="dialog"
      aria-label={t("transport.structure.panelTitle", { song: region.name })}
    >
      <header className="lt-structure-mobile-header">
        <button
          type="button"
          className="lt-structure-touch material-symbols-outlined"
          aria-label={t("transport.structure.close")}
          onClick={() => void actions.close()}
        >
          arrow_back
        </button>
        <h2>{t("transport.structure.panelTitle", { song: region.name })}</h2>
        {dirty ? (
          <span className="lt-structure-dirty">{t("transport.structure.unappliedChanges")}</span>
        ) : null}
      </header>

      {/* The only scroller on this surface (see the nested-scroller trap). */}
      <div className="lt-structure-mobile-body">
        <StructureWarnings regionId={regionId} structure={structure} handlers={handlers} />
        {!structure ? (
          <StructureCapture regionId={regionId} handlers={handlers} />
        ) : draft ? (
          <div className="lt-structure-mobile-split">
            {wide ? <TapPalette sections={structure.sections} t={t} /> : null}
            <SongStructureEditor
              sections={structure.sections}
              draft={draft}
              selectedBlockId={selectedBlockId}
              layout="vertical"
              showPalette={false}
              handleOnly
              wrapBlock={(block, row) => (
                <SwipeableRow
                  onRemove={() => removeWithUndo(block.id)}
                  onLongPress={() => setMenuBlockId(block.id)}
                >
                  {row}
                </SwipeableRow>
              )}
            />
          </div>
        ) : null}
      </div>

      {structure && draft && !wide ? (
        <button
          type="button"
          className="lt-structure-fab material-symbols-outlined"
          aria-label={t("transport.structure.addSection")}
          onClick={() => setSheetOpen(true)}
        >
          add
        </button>
      ) : null}

      {undo ? (
        <div className="lt-structure-toast" role="status">
          <span>{t("transport.structure.blockRemoved", { name: undo.name })}</span>
          <button type="button" className="lt-structure-touch" onClick={undoRemove}>
            {t("transport.structure.undoRemove")}
          </button>
        </div>
      ) : null}

      {structure && draft ? (
        <footer className="lt-structure-mobile-bar">
          <ArrangementSelect actions={actions} />
          <button
            type="button"
            className="lt-structure-touch"
            disabled={!appliedId}
            onClick={() => void actions.backToOriginal()}
          >
            {t("transport.structure.original")}
          </button>
          <button
            type="button"
            className={`lt-structure-touch is-primary ${dirty || !draftIsApplied ? "is-attention" : ""}`}
            disabled={draft.blocks.length === 0 || (draftIsApplied && !dirty)}
            onClick={() => void actions.apply()}
          >
            {t("transport.structure.apply")}
          </button>
        </footer>
      ) : null}

      {sheetOpen && structure ? (
        <PaletteSheet sections={structure.sections} t={t} onClose={() => setSheetOpen(false)} />
      ) : null}

      {menuBlock ? (
        <BlockMenu
          title={nameOf(menuBlock.sectionMarkerId)}
          t={t}
          onDuplicate={() => {
            updateDraft((d) => duplicateBlock(d, menuBlock.id));
            setMenuBlockId(null);
          }}
          onRemove={() => {
            setMenuBlockId(null);
            removeWithUndo(menuBlock.id);
          }}
          onClose={() => setMenuBlockId(null)}
        />
      ) : null}
    </div>
  );
}
