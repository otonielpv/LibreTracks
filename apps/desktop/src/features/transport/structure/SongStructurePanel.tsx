import { isMobileApp } from "../desktopApi";
import { ArrangementSelect } from "./ArrangementSelect";
import { SongStructureEditor } from "./SongStructureEditor";
import { SongStructureMobileScreen } from "./SongStructureMobileScreen";
import { StructureCapture, StructureWarnings } from "./StructureSections";
import type { StructureHandlers } from "./structureHandlers";
import { useArrangementActions, type ArrangementActions } from "./useArrangementActions";

import "./structure.css";

export { detectedSections } from "./StructureSections";
export { confirmDiscardChanges } from "./useArrangementActions";
export { ArrangementSelect } from "./ArrangementSelect";

type SongStructurePanelProps = {
  handlers: StructureHandlers;
  /** Tests force a layout; the app decides by platform. */
  variant?: "desktop" | "mobile";
};

/**
 * The arrangement editor ("Arreglo"). On desktop, a docked panel over the
 * bottom of the timeline; on phones and tablets, a full screen. Opened from
 * the song menu or the compact view's arrangement indicator. The edits stay
 * local until "Apply".
 */
export function SongStructurePanel({ handlers, variant }: SongStructurePanelProps) {
  const actions = useArrangementActions(handlers);
  if (!actions.regionId || !actions.region) return null;
  const mobile = variant ? variant === "mobile" : isMobileApp;
  return mobile ? (
    <SongStructureMobileScreen actions={actions} handlers={handlers} />
  ) : (
    <DesktopPanel actions={actions} handlers={handlers} />
  );
}

function DesktopPanel({
  actions,
  handlers,
}: {
  actions: ArrangementActions;
  handlers: StructureHandlers;
}) {
  const { t, regionId, region, structure, draft, selectedBlockId, dirty, appliedId, draftIsApplied } =
    actions;
  if (!regionId || !region) return null;
  return (
    <aside
      className="lt-structure-panel"
      role="dialog"
      aria-label={t("transport.structure.panelTitle", { song: region.name })}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          void actions.close();
        }
      }}
    >
      <header className="lt-structure-header">
        <h2>{t("transport.structure.panelTitle", { song: region.name })}</h2>
        {dirty ? (
          <span className="lt-structure-dirty">{t("transport.structure.unappliedChanges")}</span>
        ) : null}
        <button
          type="button"
          className="lt-structure-close material-symbols-outlined"
          aria-label={t("transport.structure.close")}
          onClick={() => void actions.close()}
        >
          close
        </button>
      </header>

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
            <button type="button" onClick={() => void actions.rename()}>
              {t("transport.structure.rename")}
            </button>
            <button
              type="button"
              disabled={!draft.arrangementId}
              onClick={() => void actions.remove()}
            >
              {t("transport.structure.delete")}
            </button>
          </div>
          <SongStructureEditor
            sections={structure.sections}
            draft={draft}
            selectedBlockId={selectedBlockId}
            layout="horizontal"
          />
          <footer className="lt-structure-footer">
            <button
              type="button"
              disabled={!appliedId}
              onClick={() => void actions.backToOriginal()}
            >
              {t("transport.structure.original")}
            </button>
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
    </aside>
  );
}
