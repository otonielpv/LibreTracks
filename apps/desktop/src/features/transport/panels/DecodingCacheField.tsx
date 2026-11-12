import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import type { DecodingCacheInfo } from "@libretracks/shared/desktopApi";
import {
  getDecodingCacheInfo,
  isMobileApp,
  purgeDecodingCache,
  setDecodingCacheDir,
  setDecodingCacheMaxGb,
} from "@libretracks/shared/desktopApi";
import { formatUserFacingError } from "../errors/formatTransportError";

function formatCacheBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit <= 1 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Ableton-style "Decoding Cache" controls: the folder where decoded `.rf64`
 * PCM caches live, the maximum size cap, the current on-disk size, and a manual
 * cleanup. Changing the folder does not migrate existing files (matches Ableton)
 * — old files stay until evicted or purged.
 */
export function DecodingCacheField() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DecodingCacheInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxGbDraft, setMaxGbDraft] = useState("");

  const refresh = useCallback(async () => {
    const next = await getDecodingCacheInfo();
    setInfo(next);
    setMaxGbDraft(next.maxGb != null ? String(next.maxGb) : "");
  }, []);

  useEffect(() => {
    void refresh().catch((err) =>
      setError(formatUserFacingError(err, t)),
    );
  }, [refresh, t]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(formatUserFacingError(err, t));
      } finally {
        setBusy(false);
      }
    },
    [refresh, t],
  );

  const handleChangeFolder = () =>
    void run(async () => {
      const picked = await open({ multiple: false, directory: true });
      const path = typeof picked === "string" ? picked : null;
      if (!path) return;
      await setDecodingCacheDir(path);
    });

  const handleResetFolder = () => void run(() => setDecodingCacheDir(null));

  const handleApplyMaxGb = () =>
    void run(() => {
      const trimmed = maxGbDraft.trim();
      if (trimmed === "") return setDecodingCacheMaxGb(null);
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(
          t("transport.settingsModal.decodingCacheMaxInvalid", {
            defaultValue: "Enter a whole number of GB (1 or more), or leave empty for automatic.",
          }),
        );
      }
      return setDecodingCacheMaxGb(Math.floor(parsed));
    });

  // A purge that frees nothing because the files are open must not look like a
  // successful one. The engine streams audio straight out of the PCM cache, so
  // with a session loaded every file is held open and (on Windows) undeletable.
  const handlePurge = () =>
    void run(async () => {
      const result = await purgeDecodingCache();
      if (result.filesInUse > 0) {
        throw new Error(
          t("transport.settingsModal.decodingCacheInUse", {
            count: result.filesInUse,
            defaultValue:
              "{{count}} cache file(s) are in use by the open session and could not be deleted. Close the session (or the app) and clear the cache again.",
          }),
        );
      }
    });

  return (
    <div className="lt-settings-field">
      <span className="lt-settings-field-label">
        {t("transport.settingsModal.decodingCacheTitle", {
          defaultValue: "Audio cache",
        })}
      </span>
      <small>
        {isMobileApp
          ? t("transport.settingsModal.decodingCacheDescriptionMobile", {
              defaultValue:
                "Non-WAV audio (MP3, FLAC…) is decoded once and stored here so it loads instantly next time. The location is fixed to the app's own storage.",
            })
          : t("transport.settingsModal.decodingCacheDescription", {
              defaultValue:
                "Non-WAV audio (MP3, FLAC…) is decoded once and stored here so it loads instantly next time. Changing the folder leaves old files behind until you clear the cache.",
            })}
      </small>

      <div className="lt-cache-control-row">
        <input
          type="text"
          readOnly
          value={info?.dir ?? ""}
          title={info?.dir ?? ""}
          aria-label={t("transport.settingsModal.decodingCacheLocation", {
            defaultValue: "Cache location",
          })}
        />
        {/* No folder picking on a phone. Two reasons, either one enough:
            `tauri-plugin-dialog` returns FolderPickerNotImplemented for
            `directory: true` on mobile, so the button could only ever fail;
            and writing outside the app's own storage would need
            MANAGE_EXTERNAL_STORAGE, which Play grants to file managers and
            backup tools, not to a DAW (see AndroidManifest.xml). The size cap
            and Clear cache below are the parts that still mean something. */}
        {!isMobileApp ? (
          <>
            <button
              type="button"
              className="lt-secondary-button"
              disabled={busy}
              onClick={handleChangeFolder}
            >
              {t("transport.settingsModal.decodingCacheChange", {
                defaultValue: "Change…",
              })}
            </button>
            <button
              type="button"
              className="lt-secondary-button lt-cache-reset-button"
              disabled={busy}
              title={t("transport.settingsModal.decodingCacheResetHint", {
                defaultValue: "Use the default location",
              })}
              onClick={handleResetFolder}
            >
              {t("transport.settingsModal.decodingCacheReset", {
                defaultValue: "Default",
              })}
            </button>
          </>
        ) : null}
      </div>

      <div className="lt-cache-max-row">
        <span className="lt-cache-max-label">
          {t("transport.settingsModal.decodingCacheMaxLabel", {
            defaultValue: "Maximum size",
          })}
        </span>
        <span className="lt-cache-max-input">
          <input
            type="number"
            min={1}
            step={1}
            value={maxGbDraft}
            disabled={busy}
            placeholder={t("transport.settingsModal.decodingCacheMaxAuto", {
              defaultValue: "Auto",
            })}
            aria-label={t("transport.settingsModal.decodingCacheMaxLabel", {
              defaultValue: "Maximum size",
            })}
            onChange={(event) => setMaxGbDraft(event.target.value)}
          />
          <span className="lt-cache-max-unit" aria-hidden="true">
            GB
          </span>
        </span>
        <button
          type="button"
          className="lt-secondary-button"
          disabled={busy}
          onClick={handleApplyMaxGb}
        >
          {t("transport.settingsModal.decodingCacheApplyMax", {
            defaultValue: "Set limit",
          })}
        </button>
      </div>
      <small>
        {t("transport.settingsModal.decodingCacheMaxHelp", {
          defaultValue:
            "Leave empty for automatic (10% of free disk space, at least 4 GB).",
        })}
      </small>

      <div className="lt-inline-actions">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.decodingCacheCurrentSize", {
            defaultValue: "On disk: {{size}}",
            size: formatCacheBytes(info?.sizeBytes ?? 0),
          })}
        </span>
        <button
          type="button"
          className="lt-secondary-button"
          disabled={busy || (info?.sizeBytes ?? 0) === 0}
          onClick={handlePurge}
        >
          {t("transport.settingsModal.decodingCacheClear", {
            defaultValue: "Clear cache",
          })}
        </button>
      </div>

      {error ? (
        <small className="lt-update-check-status lt-update-check-status--error">
          {error}
        </small>
      ) : null}
    </div>
  );
}
