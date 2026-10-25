import { memo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { SongRegionSummary } from "@libretracks/shared/models";

import { ArrangementSelect } from "../structure/ArrangementSelect";
import { SongStructureEditor } from "../structure/SongStructureEditor";
import { StructureCapture, StructureWarnings } from "../structure/StructureSections";
import { closeStructureEditor, openStructureEditor } from "../structure/structureEditor";
import type { StructureHandlers } from "../structure/structureHandlers";
import { ORIGINAL_SELECTION, useStructureStore } from "../structure/structureStore";
import { confirmDiscardChanges, useArrangementActions } from "../structure/useArrangementActions";
import { setEditLeaveGuard } from "./setlistStore";
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

/**
 * Edit → Arrangement in the drawer: the panel's own toolbar (picker, new,
 * rename, delete, recapture) and Apply, all from useArrangementActions. In
 * `short` the drawer covers the view, so it also brings the block strip.
 */
function SetlistArrangementToolbarComponent({ region, handlers, layout }: SetlistArrangementProps) {
  useEmbeddedArrangementEditor(region);
  const actions = useArrangementActions(handlers);
  const { t, regionId, structure, draft, dirty, draftIsApplied } = actions;
  if (!regionId) return null;
  return (
    <div className={`lt-setlist-arrangement-tools is-${layout}`}>
      <StructureWarnings regionId={regionId} structure={structure} handlers={handlers} />
      {!structure ? (
        <StructureCapture regionId={regionId} handlers={handlers} />
      ) : draft ? (
        <>
          <div className="lt-structure-toolbar">
            <ArrangementSelect actions={actions} />
            <button type="button" onClick={() => void actions.createNew()}>
              {t("transport.structure.newArrangement")}
            </button>
            <button type="button" disabled={draft.isOriginal} onClick={() => void actions.rename()}>
              {t("transport.structure.rename")}
            </button>
            <button
              type="button"
              disabled={!draft.arrangementId || draft.isOriginal}
              onClick={() => void actions.remove()}
            >
              {t("transport.structure.delete")}
            </button>
            <button type="button" onClick={() => void actions.recaptureOriginal()}>
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
          <footer className="lt-structure-footer">
            {dirty ? (
              <span className="lt-structure-dirty">{t("transport.structure.unappliedChanges")}</span>
            ) : null}
            <button
              type="button"
              className={`is-primary ${dirty || !draftIsApplied ? "is-attention" : ""}`}
              disabled={draft.blocks.length === 0 || (draftIsApplied && !dirty)}
              onClick={() => void actions.apply()}
            >
              {t("transport.structure.apply")}
            </button>
          </footer>
        </>
      ) : null}
    </div>
  );
}

export const SetlistArrangementToolbar = memo(SetlistArrangementToolbarComponent);
