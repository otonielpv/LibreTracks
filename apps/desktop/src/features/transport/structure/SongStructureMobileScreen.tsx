import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { formatTransportError } from "../errors/formatTransportError";
import { useDismissOnBack } from "../mobile/backNavigation";
import { ArrangementSelect } from "./ArrangementSelect";
import { SongStructureEditor } from "./SongStructureEditor";
import { StructureCapture, StructureWarnings } from "./StructureSections";
import { SwipeableRow } from "./SwipeableRow";
import {
  addBlock,
  closeStructureEditor,
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
 * the list). One row per section, like the app's mobile menus. */
function TapPalette({
  sections,
  t,
}: {
  sections: StructureSectionSummary[];
  t: ArrangementActions["t"];
}) {
  return (
    <div className="lt-structure-tap-palette" role="list" aria-label={t("transport.structure.palette")}>
      {sections.map((section) => (
        <button
          key={section.markerId}
          type="button"
          role="listitem"
          className="lt-structure-tap-row"
          onClick={() => updateDraft((d) => addBlock(d, section.markerId))}
        >
          <span
            className="lt-structure-swatch"
            style={{ ["--lt-structure-color" as string]: sectionColor(section) }}
            aria-hidden="true"
          />
          <span className="lt-structure-tap-name">{sectionLabel(section, t)}</span>
          <span className="lt-structure-tap-bars">{formatBars(section.bars, t)}</span>
          <span className="material-symbols-outlined lt-structure-tap-add" aria-hidden="true">
            add
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Bottom sheet with the app's own mobile-sheet look (`lt-context-menu
 * is-mobile-sheet`, as the timeline and library menus), inside a backdrop that
 * sits above this full-screen editor. Registers itself with Android's back.
 */
function Sheet({
  title,
  t,
  onClose,
  role = "dialog",
  children,
}: {
  title: string;
  t: ArrangementActions["t"];
  onClose: () => void;
  role?: "dialog" | "menu";
  children: ReactNode;
}) {
  useDismissOnBack(onClose);
  return (
    <div className="lt-structure-sheet-backdrop" onClick={onClose}>
      <section
        className="lt-context-menu is-mobile-sheet lt-structure-app-sheet"
        role={role}
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="lt-context-menu-sheet-header">
          <strong>{title}</strong>
          <button
            type="button"
            className="lt-icon-button"
            aria-label={t("transport.structure.close")}
            onClick={onClose}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function SheetItem({
  icon,
  label,
  onSelect,
  disabled,
  destructive,
}: {
  icon: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={destructive ? "is-destructive" : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        {icon}
      </span>
      {label}
    </button>
  );
}

/**
 * Arrangement editor on phones and tablets: a full screen with the blocks as
 * a vertical list. Drag by the handle to reorder, swipe left to remove (with
 * undo), long-press for Duplicate/Remove, "Add section" for the palette.
 * Android's back button closes the topmost thing, and closing with unapplied
 * changes asks. Applying closes the screen so the result shows on the
 * timeline.
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuBlockId, setMenuBlockId] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ draft: ArrangementDraft; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
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

  // The timeline is behind this full screen: closing it is how the user sees
  // the arrangement applied. A failure stays here, where it can be read (the
  // status bar it also goes to is covered by this screen).
  const apply = async () => {
    setError(null);
    setApplying(true);
    try {
      const result = await actions.apply();
      if (result.ok) {
        closeStructureEditor();
      } else if (result.error) {
        setError(formatTransportError(result.error, t as never));
      }
    } catch (failure) {
      setError(formatTransportError(failure, t as never));
    } finally {
      setApplying(false);
    }
  };

  if (!regionId || !region) return null;
  const menuBlock = draft?.blocks.find((block) => block.id === menuBlockId) ?? null;
  const appliedName = structure?.arrangements.find((a) => a.id === appliedId)?.name ?? null;

  return (
    <div
      className={`lt-structure-mobile ${wide ? "is-wide" : ""}`}
      role="dialog"
      aria-label={t("transport.structure.panelTitle", { song: region.name })}
    >
      <header className="lt-structure-mobile-header">
        <button
          type="button"
          className="lt-structure-icon-button"
          aria-label={t("transport.structure.close")}
          onClick={() => void actions.close()}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            arrow_back
          </span>
        </button>
        <div className="lt-structure-mobile-title">
          <span className="lt-structure-mobile-eyebrow">{t("transport.structure.menuItem")}</span>
          <h2>{region.name}</h2>
        </div>
        {dirty ? (
          <span
            className="lt-structure-dirty-dot"
            title={t("transport.structure.unappliedChanges")}
            aria-label={t("transport.structure.unappliedChanges")}
          />
        ) : null}
        {structure && draft ? (
          <button
            type="button"
            className="lt-structure-icon-button"
            aria-label={t("transport.structure.moreActions")}
            onClick={() => setMoreOpen(true)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              more_vert
            </span>
          </button>
        ) : null}
      </header>

      {/* The only scroller on this surface (see the nested-scroller trap). */}
      <div className="lt-structure-mobile-body">
        <StructureWarnings regionId={regionId} structure={structure} handlers={handlers} />
        {!structure ? (
          <StructureCapture regionId={regionId} handlers={handlers} />
        ) : draft ? (
          <>
            <div className="lt-structure-mobile-picker">
              <ArrangementSelect actions={actions} />
              {appliedName ? (
                <span className="lt-structure-mobile-applied">
                  {t("transport.structure.indicator", { name: appliedName })}
                </span>
              ) : null}
            </div>
            <div className="lt-structure-mobile-split">
              {wide ? <TapPalette sections={structure.sections} t={t} /> : null}
              <div className="lt-structure-mobile-list">
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
                {!wide ? (
                  // In the flow, after the last block: a floating button sat on
                  // top of the last block's drag handle.
                  <button
                    type="button"
                    className="lt-structure-add-row"
                    onClick={() => setSheetOpen(true)}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">
                      add
                    </span>
                    {t("transport.structure.addSection")}
                  </button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {undo || error ? (
        <div className={`lt-structure-toast ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>
          <span>{error ?? t("transport.structure.blockRemoved", { name: undo?.name })}</span>
          {error ? (
            <button type="button" onClick={() => setError(null)}>
              {t("transport.structure.close")}
            </button>
          ) : (
            <button type="button" onClick={undoRemove}>
              {t("transport.structure.undoRemove")}
            </button>
          )}
        </div>
      ) : null}

      {structure && draft ? (
        <footer className="lt-structure-mobile-bar">
          <button
            type="button"
            disabled={!appliedId || applying}
            onClick={() => void actions.backToOriginal()}
          >
            {t("transport.structure.original")}
          </button>
          <button
            type="button"
            className={`is-primary ${dirty || !draftIsApplied ? "is-attention" : ""}`}
            disabled={applying || draft.blocks.length === 0 || (draftIsApplied && !dirty)}
            onClick={() => void apply()}
          >
            {t("transport.structure.apply")}
          </button>
        </footer>
      ) : null}

      {sheetOpen && structure ? (
        <Sheet title={t("transport.structure.addSection")} t={t} onClose={() => setSheetOpen(false)}>
          <TapPalette sections={structure.sections} t={t} />
        </Sheet>
      ) : null}

      {moreOpen && draft ? (
        <Sheet
          title={draft.name}
          t={t}
          role="menu"
          onClose={() => setMoreOpen(false)}
        >
          <SheetItem
            icon="add"
            label={t("transport.structure.newArrangement")}
            onSelect={() => {
              setMoreOpen(false);
              void actions.createNew();
            }}
          />
          <SheetItem
            icon="edit"
            label={t("transport.structure.rename")}
            onSelect={() => {
              setMoreOpen(false);
              void actions.rename();
            }}
          />
          <SheetItem
            icon="delete"
            label={t("transport.structure.delete")}
            destructive
            disabled={!draft.arrangementId}
            onSelect={() => {
              setMoreOpen(false);
              void actions.remove();
            }}
          />
        </Sheet>
      ) : null}

      {menuBlock ? (
        <Sheet
          title={nameOf(menuBlock.sectionMarkerId)}
          t={t}
          role="menu"
          onClose={() => setMenuBlockId(null)}
        >
          <SheetItem
            icon="content_copy"
            label={t("transport.structure.duplicateBlock")}
            onSelect={() => {
              updateDraft((d) => duplicateBlock(d, menuBlock.id));
              setMenuBlockId(null);
            }}
          />
          <SheetItem
            icon="delete"
            label={t("transport.structure.removeBlock")}
            destructive
            onSelect={() => {
              setMenuBlockId(null);
              removeWithUndo(menuBlock.id);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
