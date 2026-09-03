import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DiagnosticsLogKind,
  DiagnosticsLogView,
} from "@libretracks/shared/desktopApi";
import {
  clearDiagnosticsLog,
  isMobileApp,
  readDiagnosticsLog,
  readErrorLog,
  revealErrorLog,
  saveDiagnosticsLog,
} from "@libretracks/shared/desktopApi";
import { confirmDialog } from "../../../shared/dialog/dialogService";
import { formatUserFacingError } from "../errors/formatTransportError";

function formatLogBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DiagnosticsSettingsTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReactNode>(null);
  const [openLog, setOpenLog] = useState<DiagnosticsLogKind | null>(null);
  const [logView, setLogView] = useState<DiagnosticsLogView | null>(null);
  const [isLoadingLog, setIsLoadingLog] = useState(false);

  const showError = (error: unknown) => {
    setStatus(
      <small className="lt-update-check-status lt-update-check-status--error">
        {formatUserFacingError(error, t)}
      </small>,
    );
  };

  const loadLog = async (kind: DiagnosticsLogKind) => {
    setIsLoadingLog(true);
    try {
      const view = await readDiagnosticsLog(kind);
      setLogView(view);
      setOpenLog(kind);
      setStatus(null);
    } catch (error) {
      showError(error);
    } finally {
      setIsLoadingLog(false);
    }
  };

  const handleToggleLog = (kind: DiagnosticsLogKind) => {
    if (openLog === kind) {
      setOpenLog(null);
      setLogView(null);
      return;
    }
    void loadLog(kind);
  };

  const handleSaveLog = (kind: DiagnosticsLogKind) => {
    void (async () => {
      try {
        const saved = await saveDiagnosticsLog(kind);
        setStatus(
          saved ? (
            <small className="lt-update-check-status lt-update-check-status--new">
              {t("transport.settingsModal.diagnosticsSaved", {
                defaultValue: "Log saved.",
              })}
            </small>
          ) : null,
        );
      } catch (error) {
        showError(error);
      }
    })();
  };

  const handleClearLog = (kind: DiagnosticsLogKind) => {
    void (async () => {
      const confirmed = await confirmDialog(
        kind === "engine"
          ? t("transport.settingsModal.diagnosticsClearConfirm", {
              defaultValue:
                "Delete the entire audio engine log? A new file will start with the next diagnostics.",
            })
          : t("transport.settingsModal.diagnosticsErrorClearConfirm", {
              defaultValue:
                "Delete the entire error log? New errors will be recorded normally.",
            }),
      );
      if (!confirmed) return;

      setIsLoadingLog(true);
      try {
        await clearDiagnosticsLog(kind);
        if (openLog === kind) {
          setLogView(await readDiagnosticsLog(kind));
        }
        setStatus(
          <small className="lt-update-check-status lt-update-check-status--new">
            {kind === "engine"
              ? t("transport.settingsModal.diagnosticsCleared", {
                  defaultValue: "Audio engine log deleted.",
                })
              : t("transport.settingsModal.diagnosticsErrorCleared", {
                  defaultValue: "Error log deleted.",
                })}
          </small>,
        );
      } catch (error) {
        showError(error);
      } finally {
        setIsLoadingLog(false);
      }
    })();
  };

  const handleReveal = () => {
    void revealErrorLog().catch((error) => {
      setStatus(
          <small className="lt-update-check-status lt-update-check-status--error">
          {formatUserFacingError(error, t)}
        </small>,
      );
    });
  };

  const handleCopy = () => {
    void (async () => {
      try {
        const contents = await readErrorLog();
        if (!contents.trim()) {
          setStatus(
            <small className="lt-update-check-status">
              {t("transport.settingsModal.diagnosticsEmpty", {
                defaultValue: "No errors have been recorded yet.",
              })}
            </small>,
          );
          return;
        }
        await navigator.clipboard.writeText(contents);
        setStatus(
          <small className="lt-update-check-status lt-update-check-status--new">
            {t("transport.settingsModal.diagnosticsCopied", {
              defaultValue: "Error log copied to clipboard.",
            })}
          </small>,
        );
      } catch (error) {
        setStatus(
          <small className="lt-update-check-status lt-update-check-status--error">
            {formatUserFacingError(error, t)}
          </small>,
        );
      }
    })();
  };

  return (
    <div className="lt-settings-section-grid">
      <div className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.diagnosticsTitle", {
            defaultValue: "Error log",
          })}
        </span>
        <small>
          {t("transport.settingsModal.diagnosticsDescription", {
            defaultValue:
              "If the app freezes or misbehaves, send us this log so we can find the cause. It records errors only — no audio or personal data.",
          })}
        </small>
        <div className="lt-inline-actions">
          <button
            type="button"
            className="lt-secondary-button"
            disabled={isLoadingLog}
            onClick={() => handleToggleLog("errors")}
          >
            {openLog === "errors"
              ? t("transport.settingsModal.diagnosticsHide", {
                  defaultValue: "Hide log",
                })
              : t("transport.settingsModal.diagnosticsView", {
                  defaultValue: "View log",
                })}
          </button>
          {!isMobileApp ? (
            <button
              type="button"
              className="lt-secondary-button"
              onClick={handleReveal}
            >
              {t("transport.settingsModal.diagnosticsOpenFolder", {
                defaultValue: "Open logs folder",
              })}
            </button>
          ) : null}
          <button
            type="button"
            className="lt-secondary-button"
            onClick={() => handleSaveLog("errors")}
          >
            {t("transport.settingsModal.diagnosticsSave", {
              defaultValue: "Save log…",
            })}
          </button>
          <button
            type="button"
            className="lt-secondary-button"
            onClick={handleCopy}
          >
            {t("transport.settingsModal.diagnosticsCopy", {
              defaultValue: "Copy error log",
            })}
          </button>
          <button
            type="button"
            className="lt-secondary-button"
            disabled={isLoadingLog}
            onClick={() => handleClearLog("errors")}
          >
            {t("transport.settingsModal.diagnosticsClear", {
              defaultValue: "Delete log",
            })}
          </button>
        </div>
      </div>

      <div className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.diagnosticsEngineTitle", {
            defaultValue: "Audio engine log",
          })}
        </span>
        <small>
          {t("transport.settingsModal.diagnosticsEngineDescription", {
            defaultValue:
              "What the audio engine did while playing: devices, buffers, and dropouts. This is the one to look at when a track goes silent.",
          })}
        </small>
        <div className="lt-inline-actions">
          <button
            type="button"
            className="lt-secondary-button"
            disabled={isLoadingLog}
            onClick={() => handleToggleLog("engine")}
          >
            {openLog === "engine"
              ? t("transport.settingsModal.diagnosticsHide", {
                  defaultValue: "Hide log",
                })
              : t("transport.settingsModal.diagnosticsView", {
                  defaultValue: "View log",
                })}
          </button>
          <button
            type="button"
            className="lt-secondary-button"
            onClick={() => handleSaveLog("engine")}
          >
            {t("transport.settingsModal.diagnosticsSave", {
              defaultValue: "Save log…",
            })}
          </button>
          <button
            type="button"
            className="lt-secondary-button"
            disabled={isLoadingLog}
            onClick={() => handleClearLog("engine")}
          >
            {t("transport.settingsModal.diagnosticsClear", {
              defaultValue: "Delete log",
            })}
          </button>
        </div>
      </div>

      {openLog && logView ? (
        <div className="lt-settings-field">
          <div className="lt-inline-actions lt-inline-actions--split">
            <small>
              {logView.totalBytes === 0
                ? t("transport.settingsModal.diagnosticsEmpty", {
                    defaultValue: "No errors have been recorded yet.",
                  })
                : t("transport.settingsModal.diagnosticsLogSize", {
                    size: formatLogBytes(logView.totalBytes),
                    defaultValue: "{{size}} on disk",
                  })}
              {logView.truncated
                ? ` · ${t("transport.settingsModal.diagnosticsTailOnly", {
                    defaultValue: "showing the end of the file",
                  })}`
                : ""}
            </small>
            <button
              type="button"
              className="lt-secondary-button"
              disabled={isLoadingLog}
              onClick={() => void loadLog(openLog)}
            >
              {t("transport.settingsModal.diagnosticsRefresh", {
                defaultValue: "Refresh",
              })}
            </button>
          </div>
          <pre className="lt-log-viewer" aria-live="polite">
            {logView.contents.trimEnd() ||
              t("transport.settingsModal.diagnosticsEmpty", {
                defaultValue: "No errors have been recorded yet.",
              })}
          </pre>
          <small className="lt-log-viewer-path">{logView.path}</small>
        </div>
      ) : null}

      {status ? <div className="lt-settings-field">{status}</div> : null}
    </div>
  );
}
