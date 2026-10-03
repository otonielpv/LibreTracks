import { useTranslation } from "react-i18next";

import { closeStructureGuard, useStructureStore } from "./structureStore";

type StructureGuardDialogProps = {
  onEditOriginal: (regionId: string) => void;
};

/**
 * "This song has an arrangement. Edit the original?" — shown when an edit
 * hits a song with an applied arrangement, before the edit starts or when the
 * backend rejects it.
 */
export function StructureGuardDialog({ onEditOriginal }: StructureGuardDialogProps) {
  const { t } = useTranslation();
  const guard = useStructureStore((state) => state.guard);
  if (!guard) return null;

  return (
    <div className="lt-modal-backdrop" onClick={closeStructureGuard}>
      <section
        className="lt-settings-modal lt-settings-modal--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-structure-guard-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeStructureGuard();
        }}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.structure.guard.eyebrow")}
            </span>
            <h2 id="lt-structure-guard-title">
              {t("transport.structure.guard.title", { name: guard.arrangementName })}
            </h2>
            <p>{t("transport.structure.guard.description")}</p>
          </div>
        </header>
        <div className="lt-settings-modal-body">
          <div className="lt-inline-actions">
            <button type="button" onClick={closeStructureGuard} autoFocus>
              {t("transport.structure.guard.cancel")}
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={() => onEditOriginal(guard.regionId)}
            >
              {t("transport.structure.guard.editOriginal")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
