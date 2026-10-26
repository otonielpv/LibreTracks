import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ArrangementBlockSummary,
  SongRegionSummary,
  SongView,
  StructureSectionSummary,
  WaveformSummaryDto,
} from "@libretracks/shared/models";

import { SongStructureEditor } from "../structure/SongStructureEditor";
import { formatTransportError } from "../errors/formatTransportError";
import { StructureCapture, StructureWarnings } from "../structure/StructureSections";
import {
  closeStructureEditor,
  addBlock,
  insertBlock,
  duplicateBlock,
  formatBars,
  openStructureEditor,
  sectionColor,
  sectionLabel,
  selectionOf,
  selectBlock,
  removeBlock,
  updateDraft,
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
import { SongOverviewStrip } from "./SongOverviewStrip";
import type { TimelineMenus } from "../menus/timelineMenus";

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
function SetlistArrangementEditorComponent({ region, handlers, layout, song, waveformSummaries, menus }: SetlistArrangementProps & {
  song: SongView;
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  menus: Pick<TimelineMenus, "openMenu">;
}) {
  const { t } = useTranslation();
  const actions = useArrangementActions(handlers);
  const hiddenPosition = useRef({ current: Number.NEGATIVE_INFINITY }).current;
  if (!actions.structure || !actions.draft) return null;
  const structure = actions.structure;
  const sections = new Map(structure.sections.map((section) => [section.markerId, section]));
  const spans = new Map<string, { startSeconds: number; endSeconds: number }>();
  if (structure.appliedArrangementId) {
    let cursor = region.startSeconds;
    const applied = structure.arrangements.find((arrangement) => arrangement.id === structure.appliedArrangementId);
    for (const block of applied?.blocks ?? []) {
      const section = sections.get(block.sectionMarkerId);
      if (!section) continue;
      const endSeconds = cursor + section.endSeconds - section.startSeconds;
      if (!spans.has(section.markerId)) spans.set(section.markerId, { startSeconds: cursor, endSeconds });
      cursor = endSeconds;
    }
  } else {
    for (const section of structure.sections) spans.set(section.markerId, section);
  }
  const insertButton = (index: number) => (
    <button
      type="button"
      className="lt-setlist-arrangement-insert"
      data-insert-index={index}
      aria-label={t("transport.structure.insertHere")}
      title={t("transport.structure.insertHere")}
      aria-haspopup="menu"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        const beforeId = actions.draft?.blocks[index]?.id;
        menus.openMenu(event, t("transport.structure.insertHere"), structure.sections.map((section) => ({
          label: sectionLabel(section, t),
          swatch: sectionColor(section),
          onSelect: () => {
            updateDraft((current) => {
              if (current !== actions.draft) return current;
              const at = beforeId ? current.blocks.findIndex((block) => block.id === beforeId) : current.blocks.length;
              return at < 0 ? current : insertBlock(current, at, section.markerId);
            });
          },
        })));
      }}
    >
      <span className="material-symbols-outlined" aria-hidden="true">add</span>
    </button>
  );
  return (
    <div className={`lt-setlist-arrangement is-waveform is-${layout}`}>
      <SongStructureEditor
        sections={structure.sections}
        draft={actions.draft}
        selectedBlockId={actions.selectedBlockId}
        layout={layout === "short" ? "row" : "horizontal"}
        handleOnly
        showPalette={false}
        renderGap={insertButton}
        renderEnd={() => insertButton(actions.draft!.blocks.length)}
        blockStyle={(block) => ({ flex: `${Math.max(0.001, (sections.get(block.sectionMarkerId)?.endSeconds ?? 0) - (sections.get(block.sectionMarkerId)?.startSeconds ?? 0))} 0 0` })}
        wrapBlock={(block, row) => {
          const section = sections.get(block.sectionMarkerId);
          const span = spans.get(block.sectionMarkerId);
          return (
            <div className="lt-setlist-arrangement-wave-block">
              {section ? <SongOverviewStrip
                region={{ ...region, ...(span ?? section) }}
                clips={span ? song.clips : []}
                sectionMarkers={[]}
                waveformSummaries={waveformSummaries}
                positionSecondsRef={hiddenPosition}
                layout={layout}
              /> : null}
              {row}
            </div>
          );
        }}
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
function ArrangementSelector({ actions }: { actions: ArrangementActions }) {
  const { t, structure, draft, appliedId } = actions;
  if (!structure || !draft) return null;
  const selected = selectionOf(draft);
  const barsById = new Map(structure.sections.map((section) => [section.markerId, section.bars]));
  const bars = draft.blocks.reduce((total, block) => total + (barsById.get(block.sectionMarkerId) ?? 0), 0);
  const options = [
    { id: ORIGINAL_SELECTION, name: t("transport.structure.original") },
    ...(draft.arrangementId === null && !draft.isOriginal
      ? [{ id: "", name: draft.name }]
      : []),
    ...structure.arrangements.map((arrangement) => ({
      id: arrangement.id,
      name: arrangement.name,
    })),
  ];
  return (
    <div className="lt-setlist-arrangement-selector">
      <select value={selected} aria-label={t("transport.structure.selector")} onChange={(event) => void actions.switchTo(event.target.value)}>
        {options.map((option) => (
          <option key={option.id || "draft"} value={option.id}>
            {option.name}{(option.id === ORIGINAL_SELECTION ? appliedId === null : option.id === appliedId) ? ` (${t("transport.structure.appliedBadge")})` : ""}
          </option>
        ))}
      </select>
      <ArrangementSequence blocks={draft.blocks} sections={structure.sections} />
      <span className="lt-setlist-arrangement-card-meta">
        {t("setlistView.arrangement.sectionsCount", { count: draft.blocks.length })}{" · "}{formatBars(bars, t)}
      </span>
    </div>
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
  const selectedIndex = draft?.blocks.findIndex((block) => block.id === actions.selectedBlockId) ?? -1;
  const editSelected = (operation: "duplicate" | "remove") => {
    if (!draft || selectedIndex < 0) return;
    const block = draft.blocks[selectedIndex];
    updateDraft((current) => operation === "duplicate" ? duplicateBlock(current, block.id)
      : removeBlock(current, block.id));
    const blocks = useStructureStore.getState().draft?.blocks ?? [];
    selectBlock(blocks[Math.min(selectedIndex, blocks.length - 1)]?.id ?? null);
  };
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
          <ArrangementSelector actions={actions} />
          <div className="lt-setlist-arrangement-actions">
            <select value="" aria-label={t("transport.structure.addSection")} onChange={(event) => {
              if (event.target.value) updateDraft((current) => addBlock(current, event.target.value));
            }}>
              <option value="" disabled>{t("transport.structure.addSection")}</option>
              {structure.sections.map((section) => <option key={section.markerId} value={section.markerId}>{sectionLabel(section, t)}</option>)}
            </select>
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
          <div className="lt-setlist-arrangement-actions" role="toolbar" aria-label={t("transport.structure.strip")}>
            {(["duplicate", "remove"] as const).map((operation) => {
              const label = t(operation === "duplicate" ? "setlistView.sections.duplicate" : "setlistView.sections.delete");
              return <button key={operation} type="button" className="lt-setlist-arrangement-action"
                aria-label={label} title={label}
                disabled={selectedIndex < 0}
                onClick={() => editSelected(operation)}>
                <span className="material-symbols-outlined" aria-hidden="true">{operation === "duplicate" ? "content_copy" : "delete"}</span>
              </button>;
            })}
          </div>
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
