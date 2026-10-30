import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { CloudFileFilters } from "./CloudFileFilters";
import { filterCloudFiles, NO_FILTERS, withMeta } from "./cloudFileFilter";
import { describePackageMeta } from "./packageNaming";
import { type CloudStatus } from "../desktopApi";
import { ProviderMark } from "./ProviderMark";
import { type PendingChoice, useCloudStore } from "./cloudStore";

/**
 * The two questions an import or export asks when the cloud is available:
 * *from where* (this device or one of the accounts) and *which one*.
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
  const statuses = useCloudStore((state) => state.statuses);
  const connecting = useCloudStore((state) => state.connecting);
  const refreshStatus = useCloudStore((state) => state.refreshStatus);
  const connect = useCloudStore((state) => state.connect);
  const openPanel = useCloudStore((state) => state.openPanel);
  // Second step of an export: which account. Remembered against the question
  // it belongs to, so a new question always starts at the first step.
  const [accountStepFor, setAccountStepFor] = useState<PendingChoice | null>(null);

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
  const pickingAccount = accountStepFor === pending;
  // Providers this build cannot reach are left out entirely: a card that can
  // never be pressed is noise. Before the first probe answers, `statuses` is
  // null and the cloud card says it is loading; treating that as "nothing
  // configured" used to render the cloud option permanently disabled on a
  // clean start, which read as the button being broken.
  const providers = statuses?.filter((status) => status.configured) ?? null;
  const connectedNames = (providers ?? [])
    .filter((status) => status.connected)
    .map((status) => status.name);

  const cloudHint =
    providers === null
      ? t("common.loading", { defaultValue: "Cargando…" })
      : providers.length === 0
        ? t("transport.cloud.notConfiguredShort", {
            defaultValue: "No disponible en esta compilación",
          })
        : importing
          ? connectedNames.length > 0
            ? t("transport.cloud.cloudImportFrom", {
                defaultValue: "Elegir de lo que tienes en {{providers}}",
                providers: connectedNames.join(", "),
              })
            : t("transport.cloud.connectInPanel", {
                defaultValue: "Conectar una cuenta en el panel Nube",
              })
          : t("transport.cloud.cloudExportPick", {
              defaultValue: "Subir a una de tus cuentas",
            });

  const chooseCloud = () => {
    if (!importing) {
      // Export: the account is the next question.
      setAccountStepFor(pending);
    } else if (connectedNames.length > 0) {
      // Import: no account to choose. The picker lists them all at once and
      // tags each file with where it lives.
      pending.resolve("cloud");
    } else {
      // Nothing to import from yet. Connecting happens in the panel, where
      // every provider has its button.
      pending.resolve(null);
      openPanel();
    }
  };

  const accountHint = (status: CloudStatus) =>
    connecting === status.provider
      ? t("transport.cloud.connecting", { defaultValue: "Esperando al navegador…" })
      : !status.connected
        ? t("transport.cloud.connectFirst", { defaultValue: "Conectar tu cuenta" })
        : t("transport.cloud.cloudExportHint", { defaultValue: "Subir a tu cuenta" });

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
              {pickingAccount
                ? t("transport.cloud.chooseAccount", {
                    defaultValue: "¿A qué cuenta lo subes?",
                  })
                : importing
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
          {pickingAccount ? (
            <>
              <div className="lt-storage-choice-options">
                {(providers ?? []).map((status) => (
                  <button
                    key={status.provider}
                    type="button"
                    className="lt-storage-choice-option"
                    disabled={connecting !== null}
                    onClick={() => {
                      if (status.connected) {
                        pending.resolve(status.provider);
                      } else {
                        // Connect without closing: cancelling the consent
                        // screen should leave the user back on this question,
                        // not back at the start of the export.
                        void connect(status.provider);
                      }
                    }}
                  >
                    <span className="lt-storage-choice-mark">
                      <ProviderMark provider={status.provider} />
                    </span>
                    <span className="lt-storage-choice-label">{status.name}</span>
                    <span className="lt-storage-choice-hint">{accountHint(status)}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="lt-link-button lt-storage-choice-back"
                onClick={() => setAccountStepFor(null)}
              >
                {t("common.back", { defaultValue: "Atrás" })}
              </button>
            </>
          ) : (
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
                disabled={!providers || providers.length === 0 || connecting !== null}
                onClick={chooseCloud}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {providers && providers.length === 0 ? "cloud_off" : "cloud"}
                </span>
                <span className="lt-storage-choice-label">
                  {t("transport.cloud.eyebrow", { defaultValue: "Nube" })}
                </span>
                <span className="lt-storage-choice-hint">{cloudHint}</span>
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function CloudPickerModal() {
  const { t } = useTranslation();
  const pending = useCloudStore((state) => state.pendingPick);
  const files = useCloudStore((state) => state.pickerFiles);
  const loading = useCloudStore((state) => state.pickerLoading);
  const error = useCloudStore((state) => state.error);
  // Declared before the early return: hooks cannot sit behind a condition.
  const [filters, setFilters] = useState(NO_FILTERS);

  if (!pending) {
    return null;
  }

  const cancel = () => pending.resolve(null);
  const all = withMeta(files);
  const listed = filterCloudFiles(files, filters);

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
            <span className="lt-settings-modal-eyebrow">
              {t("transport.cloud.eyebrow", { defaultValue: "Nube" })}
            </span>
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
          {error ? (
            <p className="lt-cloud-error" role="alert">
              {error}
            </p>
          ) : null}
          {loading ? (
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
                    <li key={`${file.provider}:${file.id}`}>
                      <button
                        type="button"
                        className="lt-cloud-pick"
                        onClick={() => pending.resolve(file)}
                      >
                        <span className="lt-cloud-provider-tag">{file.providerName}</span>
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
