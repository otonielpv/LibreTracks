import { useState } from "react";
import { useTranslation } from "react-i18next";

type ExportSessionModalProps = {
  isOpen: boolean;
  sessionTitle: string;
  onCancel: () => void;
  /** Called with the chosen mode. `includeAudio` true = self-contained set. */
  onConfirm: (includeAudio: boolean) => void;
};

/**
 * Ableton-style "Collect All and Save" chooser shown before exporting the WHOLE
 * session as a `.ltset`. Sibling of {@link ExportSongModal} but at session
 * granularity (every region/song, the library, automation). Two modes:
 *   - Full: bundles the audio used by clips — self-contained and portable to the
 *     PC you play live on.
 *   - Light: project + waveforms only (references audio by path) — smaller, for
 *     reuse on this same machine.
 */
export function ExportSessionModal({
  isOpen,
  sessionTitle,
  onCancel,
  onConfirm,
}: ExportSessionModalProps) {
  const { t } = useTranslation();
  const [includeAudio, setIncludeAudio] = useState(true);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="lt-modal-backdrop" onClick={onCancel}>
      <section
        className="lt-settings-modal lt-export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-export-session-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.exportSessionModal.eyebrow", {
                defaultValue: "Exportar sesión",
              })}
            </span>
            <h2 id="lt-export-session-modal-title">
              {t("transport.exportSessionModal.title", {
                defaultValue: "Exportar sesión completa",
              })}
            </h2>
            <p>
              {t("transport.exportSessionModal.description", {
                defaultValue: "{{name}}",
                name: sessionTitle,
              })}
            </p>
          </div>
        </header>

        <div className="lt-settings-modal-body">
          <label className="lt-export-option">
            <input
              type="radio"
              name="lt-export-session-mode"
              checked={includeAudio}
              onChange={() => setIncludeAudio(true)}
            />
            <span className="lt-export-option-copy">
              <strong>
                {t("transport.exportSessionModal.fullTitle", {
                  defaultValue: "Completo (para llevártelo)",
                })}
              </strong>
              <small>
                {t("transport.exportSessionModal.fullDescription", {
                  defaultValue:
                    "Incluye los audios usados y las ondas. Autocontenido: se abre en otro PC sin los archivos originales.",
                })}
              </small>
            </span>
          </label>

          <label className="lt-export-option">
            <input
              type="radio"
              name="lt-export-session-mode"
              checked={!includeAudio}
              onChange={() => setIncludeAudio(false)}
            />
            <span className="lt-export-option-copy">
              <strong>
                {t("transport.exportSessionModal.lightTitle", {
                  defaultValue: "Ligero",
                })}
              </strong>
              <small>
                {t("transport.exportSessionModal.lightDescription", {
                  defaultValue:
                    "Solo el proyecto y las ondas; referencia los audios por su ruta. Más pequeño, para reusar en este equipo.",
                })}
              </small>
            </span>
          </label>
        </div>

        <div className="lt-inline-actions lt-export-modal-actions">
          <button type="button" className="lt-secondary-button" onClick={onCancel}>
            {t("transport.exportSessionModal.cancel", { defaultValue: "Cancelar" })}
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => onConfirm(includeAudio)}
          >
            {t("transport.exportSessionModal.confirm", { defaultValue: "Exportar" })}
          </button>
        </div>
      </section>
    </div>
  );
}
