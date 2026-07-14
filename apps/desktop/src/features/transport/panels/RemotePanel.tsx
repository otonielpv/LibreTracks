import { useTranslation } from "react-i18next";
import type { RemoteServerInfo } from "@libretracks/shared/models";
import { RemoteAccessCard } from "./RemoteAccessCard";

type RemotePanelProps = {
  isOpen: boolean;
  onClose: () => void;
  remoteServerInfo: RemoteServerInfo | null;
};

export function RemotePanel({ isOpen, onClose, remoteServerInfo }: RemotePanelProps) {
  const { t } = useTranslation();

  if (!isOpen) {
    return null;
  }

  return (
    <div className="lt-modal-backdrop">
      <section
        className="lt-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-remote-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("remoteAccess.eyebrow")}
            </span>
            <h2 id="lt-remote-modal-title">{t("remoteAccess.title")}</h2>
            <p>{t("remoteAccess.description")}</p>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            onClick={onClose}
          >
            <span className="material-symbols-outlined">close</span>
            {t("common.close")}
          </button>
        </header>
        <div className="lt-settings-modal-body">
          <RemoteAccessCard remoteServerInfo={remoteServerInfo} />
        </div>
      </section>
    </div>
  );
}
