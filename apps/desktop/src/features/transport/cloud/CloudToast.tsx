import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { listenToCloudTransferProgress } from "../desktopApi";

/** e.g. "12.4 MB/s". Bytes, not bits: the number matches the file size shown. */
function formatRate(bytesPerSecond: number): string {
  const mb = bytesPerSecond / 1_048_576;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / 1024)} kB/s`;
}

/** e.g. "1:05". Rounded up, so it never shows 0:00 while still working. */
function formatEta(seconds: number): string {
  const total = Math.max(1, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}
import { useCloudStore } from "./cloudStore";

/**
 * Cloud progress and failures, visible with the panel closed.
 *
 * # Why this exists
 *
 * Exports and imports are started from menus, not from the cloud panel, so the
 * panel is shut for the entire transfer. Reporting errors only inside it meant
 * an upload could fail and the user would see precisely nothing — which is how
 * "I exported a song and it never reached Drive" looked like the export doing
 * nothing at all, rather than an error nobody was shown.
 *
 * Mounted always, renders nothing unless there is something to say.
 */
export function CloudToast() {
  const { t } = useTranslation();
  const transfer = useCloudStore((state) => state.transfer);
  const error = useCloudStore((state) => state.error);
  const isPanelOpen = useCloudStore((state) => state.isPanelOpen);
  const clearError = useCloudStore((state) => state.clearError);

  // Probed once at start-up. Without it the first import shows its Drive option
  // greyed out while the very first status call is still in flight.
  useEffect(() => {
    void useCloudStore.getState().refreshStatus();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenToCloudTransferProgress((progress) => {
      useCloudStore
        .getState()
        .setTransferProgress(
          progress.doneBytes,
          progress.totalBytes,
          progress.emittedAtUnixMs,
        );
    })
      .then((off) => {
        if (cancelled) {
          off();
        } else {
          unlisten = off;
        }
      })
      // Swallowed on purpose. This component is mounted for the whole app life,
      // so anywhere without the Tauri event bridge — the jsdom test run, a plain
      // browser — would otherwise raise an unhandled rejection on every render.
      // Losing the progress readout there is the correct outcome; crashing is
      // not.
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // The panel shows both of these itself; two copies on screen would be worse
  // than one.
  if (isPanelOpen || (!transfer && !error)) {
    return null;
  }

  return (
    <div className="lt-cloud-toast" role="status">
      {error ? (
        <div className="lt-cloud-toast-error" role="alert">
          <span className="material-symbols-outlined" aria-hidden="true">
            cloud_off
          </span>
          <span className="lt-cloud-toast-text">{error}</span>
          <button type="button" className="lt-link-button" onClick={clearError}>
            {t("common.dismiss", { defaultValue: "Descartar" })}
          </button>
        </div>
      ) : transfer ? (
        <div className="lt-cloud-toast-transfer">
          <span className="material-symbols-outlined" aria-hidden="true">
            {transfer.direction === "upload"
              ? "cloud_upload"
              : transfer.direction === "download"
                ? "cloud_download"
                : "inventory_2"}
          </span>
          <span className="lt-cloud-toast-text">
            {transfer.direction === "preparing"
              ? t("transport.cloud.preparing", {
                  defaultValue: "Preparando {{name}}…",
                  name: transfer.name,
                })
              : transfer.direction === "upload"
                ? t("transport.cloud.uploading", {
                    defaultValue: "Subiendo {{name}}…",
                    name: transfer.name,
                  })
                : t("transport.cloud.downloading", {
                    defaultValue: "Descargando {{name}}…",
                    name: transfer.name,
                  })}
          </span>
          {transfer.direction === "preparing" ? null : (
            <span className="lt-cloud-toast-percent">
              {transfer.percent}%
              {transfer.bytesPerSecond ? (
                <span className="lt-cloud-toast-rate">
                  {formatRate(transfer.bytesPerSecond)}
                  {transfer.etaSeconds !== null
                    ? ` · ${formatEta(transfer.etaSeconds)}`
                    : ""}
                </span>
              ) : null}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
