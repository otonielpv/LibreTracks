import { useTranslation } from "react-i18next";

type MissingMidiWarningModalProps = {
  deviceName: string | null;
  onDismiss: () => void;
  onDontShowAgain: () => void;
};

export function MissingMidiWarningModal({
  deviceName,
  onDismiss,
  onDontShowAgain,
}: MissingMidiWarningModalProps) {
  const { t } = useTranslation();
  if (!deviceName) return null;

  return (
    <div className="lt-modal-backdrop">
      <section
        className="lt-settings-modal lt-settings-modal--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-missing-midi-warning-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.midiWarning.eyebrow")}
            </span>
            <h2 id="lt-missing-midi-warning-title">
              {t("transport.midiWarning.title")}
            </h2>
            <p>{t("transport.midiWarning.description")}</p>
            <p>{t("transport.midiWarning.detail", { name: deviceName })}</p>
          </div>
        </header>
        <div className="lt-settings-modal-body">
          <div className="lt-inline-actions">
            <button type="button" onClick={onDismiss}>
              {t("transport.midiWarning.dismiss")}
            </button>
            <button type="button" className="is-primary" onClick={onDontShowAgain}>
              {t("transport.midiWarning.dontShowAgain")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
