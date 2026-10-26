import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ArrangementBlockSummary,
  SongRegionSummary,
  StructureSectionSummary,
} from "@libretracks/shared/models";

import { SongStructureEditor } from "../structure/SongStructureEditor";
import { formatTransportError } from "../errors/formatTransportError";
import { StructureCapture, StructureWarnings } from "../structure/StructureSections";
import {
  closeStructureEditor,
  formatBars,
  openStructureEditor,
  sectionColor,
  sectionLabel,
  selectionOf,
} from "../structure/structureEditor";
import type { StructureHandlers } from "../structure/structureHandlers";
import { ORIGINAL_SELECTION, useStructureStore } from "../structure/structureStore";
import {
  confirmDiscardChanges,
  useArrangementActions,
  type ArrangementActions,
} from "../structure/useArrangementActions";
import { requestEditMode, setEditLeaveGuard } from "./setlistStore";
import type { SetlistLayoutClass } from "./useSetlistLayout";

/**
 * The arrangement picker of the map's header, OUTSIDE edit mode (Playback
 * lets you pick tonight's arrangement without editing). Picking one applies
 * it with the arrangement handlers' own `applyArrangement`.
 */
function SetlistArrangementPickerComponent({
  region,
  handlers,
}: {
  region: SongRegionSummary;
  handlers: StructureHandlers;
}) {
  const { t } = useTranslation();
  const structure = region.structure;
  if (!structure || structure.arrangements.length === 0) return null;
  const applied = structure.appliedArrangementId ?? ORIGINAL_SELECTION;
  return (
    <label className="lt-setlist-arrangement-picker">
      <span className="material-symbols-outlined" aria-hidden="true">account_tree</span>
      <select
        value={applied}
        aria-label={t("transport.structure.selector")}
        onChange={(event) => {
          const id = event.target.value === ORIGINAL_SELECTION ? null : event.target.value;
          const name = structure.arrangements.find((arrangement) => arrangement.id === id)?.name;
          void handlers.applyArrangement(region.id, id, name);
        }}
      >
        <option value={ORIGINAL_SELECTION}>{t("transport.structure.original")}</option>
        {structure.arrangements.map((arrangement) => (
          <option key={arrangement.id} value={arrangement.id}>
            {arrangement.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export const SetlistArrangementPicker = memo(SetlistArrangementPickerComponent);

/**
 * Opens the app's arrangement editor on `region`, embedded (the panel of the
 * DAW stays hidden), and registers the «unapplied changes?» question for
 * leaving the mode. Unmounting without leaving (switching view) hands the
 * open editor back to the panel, so a draft in progress is not lost.
 */
function useEmbeddedArrangementEditor(region: SongRegionSummary) {
  const { t } = useTranslation();
  useEffect(() => {
    useStructureStore.setState({ editorHost: "embedded" });
    if (useStructureStore.getState().editorRegionId !== region.id) openStructureEditor(region.id);
    return () => useStructureStore.setState({ editorHost: "panel" });
  }, [region.id]);
  useEffect(() => {
    setEditLeaveGuard(async () => {
      if (!(await confirmDiscardChanges(t))) return false;
      closeStructureEditor();
      return true;
    });
    return () => setEditLeaveGuard(null);
  }, [t]);
}

type SetlistArrangementProps = {
  region: SongRegionSummary;
  handlers: StructureHandlers;
  layout: SetlistLayoutClass;
};

/** The block strip, in the map's place while editing the arrangement. */
function SetlistArrangementEditorComponent({ region, handlers, layout }: SetlistArrangementProps) {
  useEmbeddedArrangementEditor(region);
  const actions = useArrangementActions(handlers);
  if (!actions.structure || !actions.draft) return null;
  return (
    <div className={`lt-setlist-arrangement is-${layout}`}>
      <SongStructureEditor
        sections={actions.structure.sections}
        draft={actions.draft}
        selectedBlockId={actions.selectedBlockId}
        layout={layout === "short" ? "row" : "horizontal"}
        handleOnly={layout === "short"}
      />
    </div>
  );
}

export const SetlistArrangementEditor = memo(SetlistArrangementEditorComponent);

/** The song's sections in an arrangement's order, as coloured segments as
 * long as their bars: the card's picture of the arrangement. */
function ArrangementSequence({
  blocks,
  sections,
}: {
  blocks: ArrangementBlockSummary[];
  sections: StructureSectionSummary[];
}) {
  const { t } = useTranslation();
  const byId = new Map(sections.map((section) => [section.markerId, section]));
  return (
    <span className="lt-setlist-arrangement-sequence" aria-hidden="true">
      {blocks.map((block) => {
        const section = byId.get(block.sectionMarkerId);
        if (!section) return null;
        return (
          <span
            key={block.id}
            className="lt-setlist-arrangement-segment"
            style={{ flexGrow: Math.max(section.bars, 1), background: sectionColor(section) }}
            title={sectionLabel(section, t)}
          />
        );
      })}
    </span>
  );
}

/**
 * The saved arrangements as cards (the original first), in place of the
 * panel's select: each shows its order, length and whether it is the one on
 * the timeline. Picking one loads it as the working copy, like the select.
 */
function ArrangementCards({ actions }: { actions: ArrangementActions }) {
  const { t, structure, draft, appliedId } = actions;
  if (!structure || !draft) return null;
  const selected = selectionOf(draft);
  const barsById = new Map(structure.sections.map((section) => [section.markerId, section.bars]));
  const barsOf = (blocks: ArrangementBlockSummary[]) =>
    blocks.reduce((total, block) => total + (barsById.get(block.sectionMarkerId) ?? 0), 0);
  const original = structure.sections.map((section) => ({
    id: section.markerId,
    sectionMarkerId: section.markerId,
  }));
  const cards = [
    { id: ORIGINAL_SELECTION, name: t("transport.structure.original"), blocks: original, applied: appliedId === null },
    // A brand-new arrangement that was never saved: only the working copy.
    ...(draft.arrangementId === null && !draft.isOriginal
      ? [{ id: "", name: draft.name, blocks: draft.blocks, applied: false }]
      : []),
    ...structure.arrangements.map((arrangement) => ({
      id: arrangement.id,
      name: arrangement.name,
      blocks: arrangement.blocks,
      applied: arrangement.id === appliedId,
    })),
  ];
  return (
    <ul className="lt-setlist-arrangement-cards" aria-label={t("transport.structure.selector")}>
      {cards.map((card) => {
        const isSelected = card.id === selected;
        // The selected card shows the working copy, unapplied changes included.
        const blocks = isSelected ? draft.blocks : card.blocks;
        return (
          <li key={card.id || "draft"}>
            <button
              type="button"
              className={`lt-setlist-arrangement-card${isSelected ? " is-selected" : ""}${card.applied ? " is-applied" : ""}`}
              aria-pressed={isSelected}
              onClick={() => void actions.switchTo(card.id)}
            >
              <span className="lt-setlist-arrangement-card-head">
                <span className="lt-setlist-arrangement-card-name">{card.name}</span>
                {card.applied ? (
                  <span className="lt-setlist-arrangement-card-badge">{t("transport.structure.appliedBadge")}</span>
                ) : null}
              </span>
              <ArrangementSequence blocks={blocks} sections={structure.sections} />
              <span className="lt-setlist-arrangement-card-meta">
                {t("setlistView.arrangement.sectionsCount", { count: blocks.length })}
                {" · "}
                {formatBars(barsOf(blocks), t)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Edit → Arrangement in the drawer: the panel's own toolbar (picker, new,
 * rename, delete, recapture) and Apply, all from useArrangementActions. In
 * `short` the drawer covers the view, so it also brings the block strip.
 */
function SetlistArrangementToolbarComponent({ region, handlers, layout }: SetlistArrangementProps) {
  useEmbeddedArrangementEditor(region);
  const actions = useArrangementActions(handlers);
  const { t, regionId, structure, draft, dirty, draftIsApplied } = actions;
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async () => {
    if (applying) return;
    setError(null);
    setApplying(true);
    try {
      const result = await actions.apply();
      if (result.ok) await requestEditMode(null);
      else if (result.error) setError(formatTransportError(result.error, t as never));
    } catch (failure) {
      setError(formatTransportError(failure, t as never));
    } finally {
      setApplying(false);
    }
  };
  useEffect(() => setError(null), [regionId, draft?.arrangementId]);
  if (!regionId) return null;
  return (
    <div className={`lt-setlist-arrangement-tools is-${layout}`}>
      <StructureWarnings regionId={regionId} structure={structure} handlers={handlers} />
      {!structure ? (
        <StructureCapture regionId={regionId} handlers={handlers} />
      ) : draft ? (
        <>
          <header className="lt-setlist-arrangement-head">
            <h3>{t("setlistView.arrangement.list")}</h3>
            <button type="button" className="lt-setlist-arrangement-action" onClick={() => void actions.createNew()}>
              <span className="material-symbols-outlined" aria-hidden="true">add</span>
              {t("transport.structure.newArrangement")}
            </button>
          </header>
          <ArrangementCards actions={actions} />
          <div className="lt-setlist-arrangement-actions">
            <button
              type="button"
              className="lt-setlist-arrangement-action"
              disabled={draft.isOriginal}
              onClick={() => void actions.rename()}
            >
              <span className="material-symbols-outlined" aria-hidden="true">edit</span>
              {t("transport.structure.rename")}
            </button>
            <button
              type="button"
              className="lt-setlist-arrangement-action is-danger"
              disabled={!draft.arrangementId || draft.isOriginal}
              onClick={() => void actions.remove()}
            >
              <span className="material-symbols-outlined" aria-hidden="true">delete</span>
              {t("transport.structure.delete")}
            </button>
            <button
              type="button"
              className="lt-setlist-arrangement-action"
              onClick={() => void actions.recaptureOriginal()}
            >
              <span className="material-symbols-outlined" aria-hidden="true">restart_alt</span>
              {t("transport.structure.recapture")}
            </button>
          </div>
          {layout === "short" ? (
            <SongStructureEditor
              sections={structure.sections}
              draft={draft}
              selectedBlockId={actions.selectedBlockId}
              layout="row"
              handleOnly
            />
          ) : null}
          <footer className="lt-structure-footer lt-setlist-arrangement-footer">
            {error ? <p className="lt-setlist-arrangement-error" role="alert">{error}</p> : null}
            {dirty ? (
              <span className="lt-structure-dirty">{t("transport.structure.unappliedChanges")}</span>
            ) : null}
            <button
              type="button"
              className={`is-primary ${dirty || !draftIsApplied ? "is-attention" : ""}`}
              disabled={applying || draft.blocks.length === 0 || (draftIsApplied && !dirty)}
              aria-busy={applying}
              onClick={() => void apply()}
            >
              <span className="material-symbols-outlined" aria-hidden="true">check</span>
              {t("transport.structure.apply")}
            </button>
          </footer>
        </>
      ) : null}
    </div>
  );
}

export const SetlistArrangementToolbar = memo(SetlistArrangementToolbarComponent);
