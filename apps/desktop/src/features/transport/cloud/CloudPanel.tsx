import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// Transfer progress is subscribed once by CloudToast, which is always mounted.
import { type CloudFolder, type CloudProviderId, type CloudStatus } from "../desktopApi";
import { CloudFileFilters } from "./CloudFileFilters";
import { filterCloudFiles, NO_FILTERS, withMeta } from "./cloudFileFilter";
import { describePackageMeta } from "./packageNaming";
import { GoogleMark, ProviderMark } from "./ProviderMark";
import { statusOf, useCloudStore } from "./cloudStore";

/**
 * Connect the app to the user's own cloud accounts, and manage what is stored
 * in each.
 *
 * LibreTracks hosts nothing: this signs in to accounts the user owns (Google
 * Drive, OneDrive, Dropbox; several at once if they like) and shows the
 * `Songs` and `Sessions` folders the app keeps in each. The credentials live in
 * the OS credential store on this device, one entry per account.
 *
 * # The quota is the whole account, deliberately
 *
 * Drive counts Gmail and Photos against the same 15 GB, OneDrive counts
 * Outlook. Showing only what LibreTracks occupies would leave someone staring
 * at "1.2 GB used" unable to work out why a session will not fit, so the
 * account figure leads and the provider's own caveat sits under it.
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
 * One row per configured provider: its state and the action that makes sense.
 */
function AccountRow({
  status,
  active,
  onShow,
}: {
  status: CloudStatus;
  active: boolean;
  onShow: (provider: CloudProviderId) => void;
}) {
  const { t } = useTranslation();
  const connecting = useCloudStore((state) => state.connecting);
  const connect = useCloudStore((state) => state.connect);
  const disconnect = useCloudStore((state) => state.disconnect);
  const waiting = connecting === status.provider;

  return (
    <li className={`lt-cloud-account${active ? " is-active" : ""}`}>
      <span className="lt-cloud-account-name">
        <ProviderMark provider={status.provider} />
        <span>
          {status.name}
          <span className="lt-cloud-account-state">
            {status.connected
              ? t("transport.cloud.connectedShort", { defaultValue: "Conectada" })
              : t("transport.cloud.notConnectedShort", { defaultValue: "Sin conectar" })}
          </span>
        </span>
      </span>
      <span className="lt-cloud-account-actions">
        {status.connected ? (
          <>
            {!active ? (
              <button
                type="button"
                className="lt-ghost-button"
                onClick={() => onShow(status.provider)}
              >
                {t("transport.cloud.showFiles", { defaultValue: "Ver archivos" })}
              </button>
            ) : null}
            <button
              type="button"
              className="lt-ghost-button"
              onClick={() => void disconnect(status.provider)}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                logout
              </span>
              {t("transport.cloud.disconnect", { defaultValue: "Desconectar" })}
            </button>
          </>
        ) : status.provider === "google-drive" ? (
          // Google's branding rules ask for its own sign-in button shape.
          <button
            type="button"
            className="lt-google-button"
            disabled={connecting !== null}
            onClick={() => void connect(status.provider)}
          >
            <GoogleMark />
            <span>
              {waiting
                ? t("transport.cloud.connecting", { defaultValue: "Esperando al navegador…" })
                : t("transport.cloud.connectProvider", {
                    defaultValue: "Conectar con {{provider}}",
                    provider: status.name,
                  })}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="lt-ghost-button"
            disabled={connecting !== null}
            onClick={() => void connect(status.provider)}
          >
            {waiting
              ? t("transport.cloud.connecting", { defaultValue: "Esperando al navegador…" })
              : t("transport.cloud.connectProvider", {
                  defaultValue: "Conectar con {{provider}}",
                  provider: status.name,
                })}
          </button>
        )}
      </span>
    </li>
  );
}

/** What the provider counts against the same allowance, if anything. */
function quotaHint(provider: CloudProviderId, t: ReturnType<typeof useTranslation>["t"]) {
  switch (provider) {
    case "google-drive":
      return t("transport.cloud.quotaHint", {
        defaultValue:
          "Google comparte este espacio con Gmail y Fotos, así que no todo está disponible para LibreTracks.",
      });
    case "onedrive":
      return t("transport.cloud.quotaHintOneDrive", {
        defaultValue:
          "Microsoft comparte este espacio con Outlook, así que no todo está disponible para LibreTracks.",
      });
    default:
      return null;
  }
}

export function CloudPanel() {
  const { t } = useTranslation();
  const isOpen = useCloudStore((state) => state.isPanelOpen);
  const onClose = useCloudStore((state) => state.closePanel);
  const statuses = useCloudStore((state) => state.statuses);
  const provider = useCloudStore((state) => state.provider);
  const setProvider = useCloudStore((state) => state.setProvider);
  const quota = useCloudStore((state) => state.quota);
  const files = useCloudStore((state) => state.files);
  const loadingFolder = useCloudStore((state) => state.loadingFolder);
  const transfer = useCloudStore((state) => state.transfer);
  const cancelling = useCloudStore((state) => state.cancelling);
  const cancelTransfer = useCloudStore((state) => state.cancelTransfer);
  const error = useCloudStore((state) => state.error);
  const refreshStatus = useCloudStore((state) => state.refreshStatus);
  const refreshQuota = useCloudStore((state) => state.refreshQuota);
  const refreshFiles = useCloudStore((state) => state.refreshFiles);
  const remove = useCloudStore((state) => state.remove);
  const clearError = useCloudStore((state) => state.clearError);
  // One filter set for both folders: someone looking for a song in A minor
  // means the same thing in either list, and two independent boxes would just
  // be two places to clear.
  const [filters, setFilters] = useState(NO_FILTERS);

  const configured = statuses?.filter((status) => status.configured) ?? [];
  const active = statusOf(statuses, provider);
  const connected = active?.connected ?? false;
  const firstConnected = configured.find((status) => status.connected)?.provider;

  useEffect(() => {
    if (isOpen) {
      void refreshStatus();
    }
  }, [isOpen, refreshStatus]);

  // Show an account that is actually connected. The working provider defaults
  // to Drive, and someone who only connected Dropbox should not open the panel
  // to an empty Drive section.
  useEffect(() => {
    if (isOpen && !connected && firstConnected) {
      setProvider(firstConnected);
    }
  }, [isOpen, connected, firstConnected, setProvider]);

  useEffect(() => {
    if (!isOpen || !connected) {
      return;
    }
    // In series, not in parallel. Two concurrent Drive listings each resolve
    // the LibreTracks folder, and Drive listings are eventually consistent, so
    // both could miss a folder the other had just created and make a second
    // one. The backend caches ids now, but there is no reason to race it.
    void (async () => {
      await refreshQuota();
      for (const folder of FOLDERS) {
        await refreshFiles(folder);
      }
    })();
  }, [isOpen, connected, provider, refreshQuota, refreshFiles]);

  if (!isOpen) {
    return null;
  }

  const usedPercent =
    quota && quota.limitBytes
      ? Math.min(100, Math.round((quota.usedBytes / quota.limitBytes) * 100))
      : null;
  const hint = quotaHint(provider, t);

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

          {statuses === null ? (
            <p className="lt-cloud-note">{t("common.loading", { defaultValue: "Cargando…" })}</p>
          ) : configured.length === 0 ? (
            <p className="lt-cloud-note">
              {t("transport.cloud.notConfigured", {
                defaultValue:
                  "Esta compilación no incluye las credenciales de ningún proveedor, así que la nube no está disponible.",
              })}
            </p>
          ) : (
            <>
              {!firstConnected ? (
                <p className="lt-cloud-note">
                  {t("transport.cloud.explainer", {
                    defaultValue:
                      "Conecta tu cuenta de Google Drive, OneDrive o Dropbox para llevar canciones y sesiones de un dispositivo a otro. Puedes conectar varias a la vez y elegir cuál usar cada vez que exportas o importas. Los archivos se guardan en TU cuenta: LibreTracks no aloja nada y solo ve lo que guarda la propia aplicación.",
                  })}
                </p>
              ) : null}

              <section className="lt-cloud-folder">
                <h3>{t("transport.cloud.accounts", { defaultValue: "Cuentas" })}</h3>
                <ul className="lt-cloud-accounts">
                  {configured.map((status) => (
                    <AccountRow
                      key={status.provider}
                      status={status}
                      active={status.connected && status.provider === provider}
                      onShow={setProvider}
                    />
                  ))}
                </ul>
              </section>
            </>
          )}

          {connected && active ? (
            <>
              <h3 className="lt-cloud-active-title">
                <ProviderMark provider={provider} />
                {active.name}
              </h3>

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
                            "{{used}} de {{limit}} usados en tu cuenta de {{provider}} ({{free}} libres)",
                          used: formatBytes(quota.usedBytes),
                          limit: formatBytes(quota.limitBytes),
                          free: formatBytes(quota.freeBytes ?? 0),
                          provider: active.name,
                        })
                      : t("transport.cloud.quotaUnlimited", {
                          defaultValue: "{{used}} usados; cuenta sin límite",
                          used: formatBytes(quota.usedBytes),
                        })}
                  </p>
                  {hint ? <p className="lt-cloud-quota-hint">{hint}</p> : null}
                </div>
              ) : null}

              {transfer ? (
                <div className="lt-cloud-transfer">
                  <span>
                    <span className="material-symbols-outlined lt-spin" aria-hidden="true">
                      progress_activity
                    </span>{" "}
                    {t("transport.cloud.transferring", {
                      defaultValue: "{{name}} — {{percent}}%",
                      name: transfer.name,
                      percent: transfer.percent,
                    })}
                  </span>
                  <button
                    type="button"
                    className="lt-link-button lt-cloud-cancel"
                    disabled={cancelling}
                    onClick={() => void cancelTransfer()}
                  >
                    {cancelling
                      ? t("transport.cloud.cancelling", { defaultValue: "Cancelando…" })
                      : t("common.cancel", { defaultValue: "Cancelar" })}
                  </button>
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
          ) : null}
        </div>
      </section>
    </div>
  );
}
