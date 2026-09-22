import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MissingMediaEntry } from "@libretracks/shared/desktopApi";
import { getMissingMedia } from "@libretracks/shared/desktopApi";

import { formatUserFacingError } from "../errors/formatTransportError";
import { useDismissOnBack } from "../mobile/backNavigation";

type Props = {
  onClose: () => void;
  /**
   * Volver a enlazar `filePath` con `replacementPath`. Lo implementa el
   * llamante porque el camino difiere por plataforma (diálogo nativo en
   * escritorio, selector del WebView + import por etapas en Android) y ese
   * conocimiento ya vive allí.
   */
  onRelink: (filePath: string, replacementPath: string) => Promise<void>;
  /** Buscar a mano: abre el selector de ficheros del sistema. */
  onLocate: (filePath: string) => Promise<void> | void;
};

/**
 * Los ficheros que faltan, en una pantalla, al estilo del gestor de Ableton.
 *
 * Existe porque LibreTracks **referencia** el audio original en vez de
 * copiarlo, y referenciar tiene un coste conocido: el usuario mueve, renombra
 * o borra el original y se entera en mitad de un directo. Aquí ve de un
 * vistazo qué falta, **qué pistas se van a quedar mudas** y dónde se esperaba
 * cada fichero.
 *
 * Los candidatos se **proponen**: un fichero con el mismo nombre no es
 * necesariamente el mismo fichero, y enlazar el equivocado en silencio es peor
 * que no encontrarlo. Cada propuesta lleva su botón.
 *
 * No es un diálogo bloqueante al abrir la sesión, a propósito: la sesión se
 * abre igual y suena lo que pueda sonar. Esto se abre cuando el usuario pulsa
 * el aviso.
 */
export function MissingMediaModal({ onClose, onRelink, onLocate }: Props) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<MissingMediaEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  useDismissOnBack(onClose);

  const refresh = useCallback(async () => {
    try {
      setEntries(await getMissingMedia());
    } catch (err) {
      setError(formatUserFacingError(err, t));
      setEntries([]);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (filePath: string, action: () => Promise<void> | void) => {
      setBusyPath(filePath);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(formatUserFacingError(err, t));
      } finally {
        setBusyPath(null);
      }
    },
    [refresh, t],
  );

  return (
    <div className="lt-modal-backdrop" onClick={onClose}>
      <section
        className="lt-settings-modal lt-missing-media-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-missing-media-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <h2 id="lt-missing-media-title">
              {t("transport.missingMedia.title", {
                defaultValue: "Archivos que faltan",
              })}
            </h2>
            <p>
              {t("transport.missingMedia.description", {
                defaultValue:
                  "La sesión apunta a estos audios y no están donde se esperaba. Las pistas que los usan suenan mudas hasta que los vuelvas a enlazar.",
              })}
            </p>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            aria-label={t("common.close", { defaultValue: "Cerrar" })}
            onClick={onClose}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="lt-missing-media-body">
          {error ? (
            <p className="lt-update-check-status lt-update-check-status--error">
              {error}
            </p>
          ) : null}

          {entries === null ? (
            <p>{t("common.loading", { defaultValue: "Cargando…" })}</p>
          ) : entries.length === 0 ? (
            <p className="lt-missing-media-empty">
              {t("transport.missingMedia.allPresent", {
                defaultValue: "No falta ningún archivo. Todo en su sitio.",
              })}
            </p>
          ) : (
            <ul className="lt-missing-media-list">
              {entries.map((entry) => (
                <li key={entry.filePath} className="lt-missing-media-item">
                  <div className="lt-missing-media-name">
                    <span
                      className="material-symbols-outlined"
                      aria-hidden="true"
                    >
                      warning
                    </span>
                    {entry.fileName}
                  </div>
                  <div className="lt-missing-media-tracks">
                    {t("transport.missingMedia.usedBy", {
                      defaultValue: "Lo usan: {{tracks}}",
                      tracks: entry.trackNames.join(", "),
                    })}
                  </div>
                  <code
                    className="lt-missing-media-path"
                    title={entry.expectedPath}
                  >
                    {entry.expectedPath}
                  </code>

                  <div className="lt-missing-media-actions">
                    {entry.candidates.map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        className="lt-secondary-button"
                        disabled={busyPath !== null}
                        title={candidate}
                        onClick={() =>
                          void run(entry.filePath, () =>
                            onRelink(entry.filePath, candidate),
                          )
                        }
                      >
                        {t("transport.missingMedia.useCandidate", {
                          defaultValue: "Usar el de {{folder}}",
                          folder: parentFolderName(candidate),
                        })}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="lt-secondary-button"
                      disabled={busyPath !== null}
                      onClick={() =>
                        void run(entry.filePath, () => onLocate(entry.filePath))
                      }
                    >
                      {t("transport.missingMedia.locate", {
                        defaultValue: "Buscar…",
                      })}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

/** Nombre de la carpeta que contiene `path`, para etiquetar un candidato. */
function parentFolderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 2] ?? path;
}
