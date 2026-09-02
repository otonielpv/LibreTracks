import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// Transfer progress is subscribed once by CloudToast, which is always mounted.
import { type CloudFolder } from "../desktopApi";
import { CloudFileFilters } from "./CloudFileFilters";
import { filterCloudFiles, NO_FILTERS, withMeta } from "./cloudFileFilter";
import { describePackageMeta } from "./packageNaming";
import { useCloudStore } from "./cloudStore";

/**
 * Connect the app to the user's own Google Drive, and manage what is stored
 * there.
 *
 * LibreTracks hosts nothing: this signs in to an account the user owns and
 * shows the `LibreTracks/Songs` and `LibreTracks/Sessions` folders it created
 * inside it. The credential lives in the OS credential store on this device.
 *
 * # The quota is the whole account, deliberately
 *
 * Drive counts Gmail and Photos against the same 15 GB. Showing only what
 * LibreTracks occupies would leave someone staring at "1.2 GB used" unable to
 * work out why a session will not fit, so the account figure leads and the
 * app's own share is secondary.
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

const FOLDERS: CloudFolder[] = ["sessions", "songs"];

/**
 * The Google "G", inline.
 *
 * Inline rather than a remote asset because the app must work offline, and
 * because loading Google branding from Google would be a request we make on the
 * user behalf for no reason. The four paths and their colours are the mark as
 * published: it must not be recoloured, rotated or redrawn, so leave it alone.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function CloudPanel() {
  const { t } = useTranslation();
  const isOpen = useCloudStore((state) => state.isPanelOpen);
  const onClose = useCloudStore((state) => state.closePanel);
  const status = useCloudStore((state) => state.status);
  const quota = useCloudStore((state) => state.quota);
  const files = useCloudStore((state) => state.files);
  const connecting = useCloudStore((state) => state.connecting);
  const loadingFolder = useCloudStore((state) => state.loadingFolder);
  const transfer = useCloudStore((state) => state.transfer);
  const cancelling = useCloudStore((state) => state.cancelling);
  const cancelTransfer = useCloudStore((state) => state.cancelTransfer);
  const error = useCloudStore((state) => state.error);
  const refreshStatus = useCloudStore((state) => state.refreshStatus);
  const connect = useCloudStore((state) => state.connect);
  const disconnect = useCloudStore((state) => state.disconnect);
  const refreshQuota = useCloudStore((state) => state.refreshQuota);
  const refreshFiles = useCloudStore((state) => state.refreshFiles);
  const remove = useCloudStore((state) => state.remove);
  const clearError = useCloudStore((state) => state.clearError);
  // One filter set for both folders: someone looking for a song in A minor
  // means the same thing in either list, and two independent boxes would just
  // be two places to clear.
  const [filters, setFilters] = useState(NO_FILTERS);

  const connected = status?.connected ?? false;

  useEffect(() => {
    if (isOpen) {
      void refreshStatus();
    }
  }, [isOpen, refreshStatus]);

  useEffect(() => {
    if (!isOpen || !connected) {
      return;
    }
    // In series, not in parallel. Two concurrent listings each resolve the
    // LibreTracks folder, and Drive listings are eventually consistent, so both
    // could miss a folder the other had just created and make a second one.
    // The backend caches ids now, but there is no reason to race it either.
    void (async () => {
      await refreshQuota();
      for (const folder of FOLDERS) {
        await refreshFiles(folder);
      }
    })();
  }, [isOpen, connected, refreshQuota, refreshFiles]);

  if (!isOpen) {
    return null;
  }

  const usedPercent =
    quota && quota.limitBytes
      ? Math.min(100, Math.round((quota.usedBytes / quota.limitBytes) * 100))
      : null;

  return (
    <div className="lt-modal-backdrop" onClick={onClose}>
      <section
        className="lt-settings-modal lt-cloud-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-cloud-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.cloud.eyebrow", { defaultValue: "Nube" })}
            </span>
            <h2 id="lt-cloud-modal-title">
              {t("transport.cloud.title", {
                defaultValue: "Tus canciones y sesiones en la nube",
              })}
            </h2>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            aria-label={t("common.close", { defaultValue: "Cerrar" })}
            onClick={onClose}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </header>

        <div className="lt-settings-modal-body">
          {error ? (
            <p className="lt-cloud-error" role="alert">
              {error}
              <button type="button" className="lt-link-button" onClick={clearError}>
                {t("common.dismiss", { defaultValue: "Descartar" })}
              </button>
            </p>
          ) : null}

          {status && !status.configured ? (
            <p className="lt-cloud-note">
              {t("transport.cloud.notConfigured", {
                defaultValue:
                  "Esta compilación no incluye las credenciales de Google, así que la nube no está disponible.",
              })}
            </p>
          ) : !connected ? (
            <>
              <p className="lt-cloud-note">
                {t("transport.cloud.explainer", {
                  defaultValue:
                    "Conecta tu cuenta de Google Drive para llevar canciones y sesiones de un dispositivo a otro. Los archivos se guardan en TU cuenta: LibreTracks no aloja nada y solo puede ver los archivos que crea la propia aplicación.",
                })}
              </p>
              <button
                type="button"
                className="lt-google-button"
                disabled={connecting}
                onClick={() => void connect()}
              >
                <GoogleMark />
                <span>
                  {connecting
                    ? t("transport.cloud.connecting", {
                        defaultValue: "Esperando al navegador…",
                      })
                    : t("transport.cloud.connect", {
                        defaultValue: "Conectar con Google Drive",
                      })}
                </span>
              </button>
            </>
          ) : (
            <>
              <div className="lt-cloud-account">
                <span className="lt-cloud-account-name">
                  <GoogleMark />
                  {t("transport.cloud.connectedTo", {
                    defaultValue: "Conectado a {{provider}}",
                    provider: status?.provider ?? "Google Drive",
                  })}
                </span>
                <button
                  type="button"
                  className="lt-ghost-button"
                  onClick={() => void disconnect()}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">
                    logout
                  </span>
                  {t("transport.cloud.disconnect", {
                    defaultValue: "Desconectar",
                  })}
                </button>
              </div>

              {quota ? (
                <div className="lt-cloud-quota">
                  {usedPercent !== null ? (
                    <div
                      className="lt-cloud-quota-bar"
                      role="progressbar"
                      aria-valuenow={usedPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span style={{ width: `${usedPercent}%` }} />
                    </div>
                  ) : null}
                  <p>
                    {quota.limitBytes
                      ? t("transport.cloud.quota", {
                          defaultValue:
                            "{{used}} de {{limit}} usados en tu cuenta de Google ({{free}} libres)",
                          used: formatBytes(quota.usedBytes),
                          limit: formatBytes(quota.limitBytes),
                          free: formatBytes(quota.freeBytes ?? 0),
                        })
                      : t("transport.cloud.quotaUnlimited", {
                          defaultValue: "{{used}} usados; cuenta sin límite",
                          used: formatBytes(quota.usedBytes),
                        })}
                  </p>
                  <p className="lt-cloud-quota-hint">
                    {t("transport.cloud.quotaHint", {
                      defaultValue:
                        "Google comparte este espacio con Gmail y Fotos, así que no todo está disponible para LibreTracks.",
                    })}
                  </p>
                </div>
              ) : null}

              {transfer ? (
                <div className="lt-cloud-transfer">
                  <span>
                    <span
                      className="material-symbols-outlined lt-spin"
                      aria-hidden="true"
                    >
                      progress_activity
                    </span>{" "}
                    {t("transport.cloud.transferring", {
                      defaultValue: "{{name}} — {{percent}}%",
                      name: transfer.name,
                      percent: transfer.percent,
                    })}
                  </span>
                  {(
                    <button
                      type="button"
                      className="lt-link-button lt-cloud-cancel"
                      disabled={cancelling}
                      onClick={() => void cancelTransfer()}
                    >
                      {cancelling
                        ? t("transport.cloud.cancelling", {
                            defaultValue: "Cancelando…",
                          })
                        : t("common.cancel", { defaultValue: "Cancelar" })}
                    </button>
                  )}
                </div>
              ) : null}

              <CloudFileFilters
                filters={filters}
                onChange={setFilters}
                all={withMeta([...files.sessions, ...files.songs])}
                shownCount={
                  filterCloudFiles(files.sessions, filters).length +
                  filterCloudFiles(files.songs, filters).length
                }
              />

              {FOLDERS.map((folder) => {
                const listed = filterCloudFiles(files[folder], filters);
                return (
                  <section key={folder} className="lt-cloud-folder">
                    <h3>
                      {folder === "sessions"
                        ? t("transport.cloud.sessions", { defaultValue: "Sesiones" })
                        : t("transport.cloud.songs", { defaultValue: "Canciones" })}
                    </h3>
                    {loadingFolder === folder ? (
                      <p className="lt-cloud-note">
                        {t("common.loading", { defaultValue: "Cargando…" })}
                      </p>
                    ) : listed.length === 0 ? (
                      <p className="lt-cloud-note">
                        {files[folder].length === 0
                          ? t("transport.cloud.empty", {
                              defaultValue: "Todavía no has subido nada aquí.",
                            })
                          : t("transport.cloud.noMatches", {
                              defaultValue: "Nada coincide con esa búsqueda.",
                            })}
                      </p>
                    ) : (
                      <ul className="lt-cloud-list">
                        {listed.map((file) => (
                          <li key={file.id}>
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
                            <button
                              type="button"
                              className="lt-link-button lt-danger"
                              onClick={() => void remove(folder, file.id)}
                            >
                              {t("common.delete", { defaultValue: "Borrar" })}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
