import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { CloudFileFilters } from "./CloudFileFilters";
import { filterCloudFiles, NO_FILTERS, withMeta } from "./cloudFileFilter";
import { describePackageMeta } from "./packageNaming";
import { useCloudStore } from "./cloudStore";

/**
 * The two questions an import or export asks when the cloud is available:
 * *from where* and *which one*.
 *
 * Rendered once, near the other modals. They show only while a flow in
 * `cloudFlows` is waiting on them, and they answer by resolving that flow, so
 * neither holds any state of its own.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function StorageChoiceModal() {
  const { t } = useTranslation();
  const pending = useCloudStore((state) => state.pendingChoice);
  const status = useCloudStore((state) => state.status);
  const connecting = useCloudStore((state) => state.connecting);
  const refreshStatus = useCloudStore((state) => state.refreshStatus);
  const connect = useCloudStore((state) => state.connect);

  useEffect(() => {
    if (pending) {
      void refreshStatus();
    }
  }, [pending, refreshStatus]);

  if (!pending) {
    return null;
  }

  const cancel = () => pending.resolve(null);
  const importing = pending.intent === "import";
  // A build with no credentials cannot offer the cloud at all; one that simply
  // has no account yet can, by offering to connect right here rather than
  // sending the user off to a settings panel and back.
  // Three states, not two. Before the first probe answers, `status` is null:
  // treating that as "not configured" rendered the Drive option permanently
  // disabled on a clean start, which read as the button being broken.
  const checking = status === null;
  const configured = status?.configured ?? false;
  const connected = status?.connected ?? false;

  return (
    <div className="lt-modal-backdrop" onClick={cancel}>
      <section
        className="lt-settings-modal lt-storage-choice-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-storage-choice-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {pending.kind === "song"
                ? t("transport.cloud.kindSong", { defaultValue: "Canción" })
                : t("transport.cloud.kindSession", { defaultValue: "Sesión" })}
            </span>
            <h2 id="lt-storage-choice-title">
              {importing
                ? t("transport.cloud.chooseImportSource", {
                    defaultValue: "¿Desde dónde quieres importar?",
                  })
                : t("transport.cloud.chooseExportTarget", {
                    defaultValue: "¿Dónde quieres guardarlo?",
                  })}
            </h2>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            aria-label={t("common.close", { defaultValue: "Cerrar" })}
            onClick={cancel}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </header>

        <div className="lt-settings-modal-body">
          <div className="lt-storage-choice-options">
            <button
              type="button"
              className="lt-storage-choice-option"
              onClick={() => pending.resolve("local")}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                computer
              </span>
              <span className="lt-storage-choice-label">
                {t("transport.cloud.thisDevice", {
                  defaultValue: "Este equipo",
                })}
              </span>
              <span className="lt-storage-choice-hint">
                {importing
                  ? t("transport.cloud.thisDeviceImportHint", {
                      defaultValue: "Elegir un archivo del disco",
                    })
                  : t("transport.cloud.thisDeviceExportHint", {
                      defaultValue: "Guardar en una carpeta del disco",
                    })}
              </span>
            </button>

            <button
              type="button"
              className="lt-storage-choice-option"
              disabled={checking || !configured || connecting}
              onClick={() => {
                if (connected) {
                  pending.resolve("cloud");
                } else {
                  // Connect without closing: cancelling the consent screen
                  // should leave the user back on this question, not back at
                  // the start of the import.
                  void connect();
                }
              }}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                cloud
              </span>
              <span className="lt-storage-choice-label">Google Drive</span>
              <span className="lt-storage-choice-hint">
                {checking
                  ? t("common.loading", { defaultValue: "Cargando…" })
                  : !configured
                    ? t("transport.cloud.notConfiguredShort", {
                        defaultValue: "No disponible en esta compilación",
                      })
                    : connecting
                      ? t("transport.cloud.connecting", {
                          defaultValue: "Esperando al navegador…",
                        })
                      : !connected
                        ? t("transport.cloud.connectFirst", {
                            defaultValue: "Conectar tu cuenta",
                          })
                        : importing
                          ? t("transport.cloud.cloudImportHint", {
                              defaultValue: "Elegir de lo que tienes subido",
                            })
                          : t("transport.cloud.cloudExportHint", {
                              defaultValue: "Subir a tu cuenta",
                            })}
              </span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function CloudPickerModal() {
  const { t } = useTranslation();
  const pending = useCloudStore((state) => state.pendingPick);
  const files = useCloudStore((state) => state.files);
  const loadingFolder = useCloudStore((state) => state.loadingFolder);
  // Declared before the early return: hooks cannot sit behind a condition.
  const [filters, setFilters] = useState(NO_FILTERS);

  if (!pending) {
    return null;
  }

  const cancel = () => pending.resolve(null);
  const inFolder = files[pending.folder];
  const all = withMeta(inFolder);
  const listed = filterCloudFiles(inFolder, filters);

  return (
    <div className="lt-modal-backdrop" onClick={cancel}>
      <section
        className="lt-settings-modal lt-cloud-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-cloud-picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">Google Drive</span>
            <h2 id="lt-cloud-picker-title">
              {pending.folder === "sessions"
                ? t("transport.cloud.pickSession", {
                    defaultValue: "Elige una sesión",
                  })
                : t("transport.cloud.pickSong", {
                    defaultValue: "Elige una canción",
                  })}
            </h2>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            aria-label={t("common.close", { defaultValue: "Cerrar" })}
            onClick={cancel}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </header>

        <div className="lt-settings-modal-body">
          {loadingFolder === pending.folder ? (
            <p className="lt-cloud-note">
              {t("common.loading", { defaultValue: "Cargando…" })}
            </p>
          ) : (
            <>
              <CloudFileFilters
                filters={filters}
                onChange={setFilters}
                all={all}
                shownCount={listed.length}
              />
              {listed.length === 0 ? (
                <p className="lt-cloud-note">
                  {all.length === 0
                    ? t("transport.cloud.emptyPicker", {
                        defaultValue:
                          "No hay nada subido todavía. Exporta algo a la nube primero.",
                      })
                    : t("transport.cloud.noMatches", {
                        defaultValue: "Nada coincide con esa búsqueda.",
                      })}
                </p>
              ) : (
                <ul className="lt-cloud-list">
                  {listed.map((file) => (
                    <li key={file.id}>
                      <button
                        type="button"
                        className="lt-cloud-pick"
                        onClick={() => pending.resolve(file)}
                      >
                        <span className="lt-cloud-file-name">
                          {file.meta.title}
                          {describePackageMeta(file.meta) ? (
                            <span className="lt-cloud-file-meta">
                              {describePackageMeta(file.meta)}
                            </span>
                          ) : null}
                        </span>
                        <span className="lt-cloud-file-size">
                          {formatBytes(file.sizeBytes)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/** Both flow modals, rendered together. */
export function CloudFlowModals() {
  return (
    <>
      <StorageChoiceModal />
      <CloudPickerModal />
    </>
  );
}
