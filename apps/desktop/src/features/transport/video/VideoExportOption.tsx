import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getVideoExportPayload, type VideoExportPayload } from "../desktopApi";

/** Above this, an upload to the cloud leaves the videos out unless ticked:
 * the quota and the upload time punish it (paso 12). */
export const CLOUD_VIDEO_DEFAULT_OFF_BYTES = 500 * 1024 * 1024;

/** Whether "include videos" starts ticked. */
export function defaultIncludeVideo(bytes: number, toCloud: boolean) {
  return !(toCloud && bytes > CLOUD_VIDEO_DEFAULT_OFF_BYTES);
}

/** "2,4 GB", "180 MB" in the UI language. */
export function formatBytes(bytes: number, locale?: string) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[unit]}`;
}

/**
 * The videos an export would carry (count and size, a `stat` per file), read
 * when the dialog opens. `regionId` for one song, `null` for the session.
 * Phones too since plan video-mobile: a session edited on a phone goes
 * back to the desktop with its videos.
 */
export function useVideoExportPayload(open: boolean, regionId: string | null) {
  const [payload, setPayload] = useState<VideoExportPayload | null>(null);
  useEffect(() => {
    setPayload(null);
    if (!open) return;
    let cancelled = false;
    void getVideoExportPayload(regionId)
      .then((result) => {
        if (!cancelled) setPayload(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, regionId]);
  return payload;
}

type VideoExportOptionProps = {
  payload: VideoExportPayload | null;
  /** In Light mode nothing is bundled: only the note. */
  light: boolean;
  includeVideo: boolean;
  onChange: (includeVideo: boolean) => void;
};

/**
 * The "this song has N videos" block of the export dialogs. Absent when there
 * is no video, so a session without video exports exactly as before.
 */
export function VideoExportOption({ payload, light, includeVideo, onChange }: VideoExportOptionProps) {
  const { t, i18n } = useTranslation();
  if (!payload || payload.count === 0) return null;
  const size = formatBytes(payload.bytes, i18n.language);
  return (
    <div className="lt-video-export-option" role="group" aria-label={t("transport.video.export.title")}>
      <p className="lt-video-export-summary">
        <span className="material-symbols-outlined" aria-hidden="true">
          movie
        </span>
        {t("transport.video.export.summary", { count: payload.count, size })}
      </p>
      {light ? (
        <small>{t("transport.video.export.lightNote")}</small>
      ) : (
        <label className="lt-export-option">
          <input type="checkbox" checked={includeVideo} onChange={(event) => onChange(event.target.checked)} />
          <span className="lt-export-option-copy">
            <strong>{t("transport.video.export.include")}</strong>
            <small>{t("transport.video.export.withoutNote")}</small>
          </span>
        </label>
      )}
    </div>
  );
}
