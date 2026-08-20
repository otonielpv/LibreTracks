import { useState } from "react";
import { useTranslation } from "react-i18next";

/** Which of the three shapes the exported `.ltset` takes. */
export type SessionExportMode = "full" | "optimized" | "light";

type ExportSessionModalProps = {
  isOpen: boolean;
  sessionTitle: string;
  onCancel: () => void;
  /** Called with the chosen mode. */
  onConfirm: (mode: SessionExportMode) => void;
};

/**
 * Ableton-style "Collect All and Save" chooser shown before exporting the WHOLE
 * session as a `.ltset`. Sibling of {@link ExportSongModal} but at session
 * granularity (every region/song, the library, automation). Three modes:
 *   - Full: bundles the audio used by clips — self-contained and portable to the
 *     PC you play live on.
 *   - Optimized: bundles that audio already decoded, so the target opens without
 *     preparing anything. Bigger file, far faster to open on a phone or an old
 *     laptop.
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
  const [mode, setMode] = useState<SessionExportMode>("full");

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
              checked={mode === "full"}
              onChange={() => setMode("full")}
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
              checked={mode === "optimized"}
              onChange={() => setMode("optimized")}
            />
            <span className="lt-export-option-copy">
              <strong>
                {t("transport.exportSessionModal.optimizedTitle", {
                  defaultValue: "Optimizado (para móviles y equipos lentos)",
                })}
              </strong>
              <small>
                {t("transport.exportSessionModal.optimizedDescription", {
                  defaultValue:
                    "Incluye los audios ya preparados, así que la sesión abre al instante sin esperar a \"Preparando audio\". El archivo ocupa más.",
                })}
              </small>
            </span>
          </label>

          <label className="lt-export-option">
            <input
              type="radio"
              name="lt-export-session-mode"
              checked={mode === "light"}
              onChange={() => setMode("light")}
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
            onClick={() => onConfirm(mode)}
          >
            {t("transport.exportSessionModal.confirm", { defaultValue: "Exportar" })}
          </button>
        </div>
      </section>
    </div>
  );
}
