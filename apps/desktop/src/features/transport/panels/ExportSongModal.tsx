import { useState } from "react";
import { useTranslation } from "react-i18next";

export type ExportSongTarget = {
  regionId: string;
  regionName: string;
};

type ExportSongModalProps = {
  target: ExportSongTarget | null;
  onCancel: () => void;
  /** Called with the chosen mode. `includeAudio` true = self-contained package. */
  onConfirm: (regionId: string, includeAudio: boolean) => void;
};

/**
 * Ableton-style "Collect All and Save" chooser shown before exporting a song
 * (region) as a `.ltpkg`. Two modes:
 *   - Light: manifest + waveforms only (references audio by path) — for reuse in
 *     the same environment.
 *   - Full: also bundles the used audio files — self-contained and portable to
 *     another PC or to share with someone.
 */
export function ExportSongModal({
  target,
  onCancel,
  onConfirm,
}: ExportSongModalProps) {
  const { t } = useTranslation();
  const [includeAudio, setIncludeAudio] = useState(true);

  if (!target) {
    return null;
  }

  return (
    <div className="lt-modal-backdrop" onClick={onCancel}>
      <section
        className="lt-settings-modal lt-export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-export-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.exportModal.eyebrow", { defaultValue: "Exportar" })}
            </span>
            <h2 id="lt-export-modal-title">
              {t("transport.exportModal.title", {
                defaultValue: "Exportar canción",
              })}
            </h2>
            <p>
              {t("transport.exportModal.description", {
                defaultValue: "{{name}}",
                name: target.regionName,
              })}
            </p>
          </div>
        </header>

        <div className="lt-settings-modal-body">
          <label className="lt-export-option">
            <input
              type="radio"
              name="lt-export-mode"
              checked={includeAudio}
              onChange={() => setIncludeAudio(true)}
            />
            <span className="lt-export-option-copy">
              <strong>
                {t("transport.exportModal.fullTitle", {
                  defaultValue: "Completo (para compartir)",
                })}
              </strong>
              <small>
                {t("transport.exportModal.fullDescription", {
                  defaultValue:
                    "Incluye los audios usados y las ondas. Autocontenido: se abre en otro PC sin los archivos originales.",
                })}
              </small>
            </span>
          </label>

          <label className="lt-export-option">
            <input
              type="radio"
              name="lt-export-mode"
              checked={!includeAudio}
              onChange={() => setIncludeAudio(false)}
            />
            <span className="lt-export-option-copy">
              <strong>
                {t("transport.exportModal.lightTitle", {
                  defaultValue: "Ligero",
                })}
              </strong>
              <small>
                {t("transport.exportModal.lightDescription", {
                  defaultValue:
                    "Solo el proyecto y las ondas; referencia los audios por su ruta. Más pequeño, para reusar en este equipo.",
                })}
              </small>
            </span>
          </label>
        </div>

        <div className="lt-inline-actions lt-export-modal-actions">
          <button type="button" className="lt-secondary-button" onClick={onCancel}>
            {t("transport.exportModal.cancel", { defaultValue: "Cancelar" })}
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => onConfirm(target.regionId, includeAudio)}
          >
            {t("transport.exportModal.confirm", { defaultValue: "Exportar" })}
          </button>
        </div>
      </section>
    </div>
  );
}
