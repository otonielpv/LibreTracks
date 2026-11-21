import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DismissOnBack } from "../transport/mobile/DismissOnBack";

/** The modal frame both lyrics panels use (same look as Settings). */
export function LyricsModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="lt-modal-backdrop lt-lyrics-backdrop" onClick={onClose}>
      <DismissOnBack close={onClose} />
      <section
        className="lt-settings-modal lt-lyrics-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <h2>{title}</h2>
          </div>
          <button type="button" className="lt-settings-modal-close" onClick={onClose}>
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
            {t("common.close")}
          </button>
        </header>
        <div className="lt-lyrics-modal-body">{children}</div>
      </section>
    </div>
  );
}
