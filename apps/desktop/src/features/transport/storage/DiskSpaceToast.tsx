import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listenToDiskSpaceLow, type DiskSpaceLowNotice } from "../desktopApi";

/** "850 MB", "4,3 GB": the scale people read their disk in. */
export function formatDiskSize(mb: number, locale?: string): string {
  if (mb < 1024) return `${Math.max(0, Math.round(mb))} MB`;
  const gb = mb / 1024;
  return `${gb.toLocaleString(locale, { maximumFractionDigits: 1 })} GB`;
}

/**
 * «No queda espacio en disco para preparar el audio».
 *
 * The engine refuses a cache conversion the disk cannot take, and those tracks
 * play silence. Unlike the template toast this one stays until closed: it
 * explains silent tracks, and missing it means a silent song on stage.
 *
 * Mounted always; renders nothing until the backend reports a shortfall.
 */
export function DiskSpaceToast() {
  const { t, i18n } = useTranslation();
  const [notice, setNotice] = useState<DiskSpaceLowNotice | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenToDiskSpaceLow(setNotice)
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      // No Tauri event bridge (jsdom, a plain browser): nothing to listen to.
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!notice) return null;

  return (
    <div className="lt-disk-space-toast" role="alert">
      <span className="material-symbols-outlined" aria-hidden="true">
        hard_drive
      </span>
      <span className="lt-disk-space-toast-text">
        {t("diskSpace.low", {
          count: notice.failedSources,
          needed: formatDiskSize(notice.neededMb, i18n.language),
          free: formatDiskSize(notice.freeMb, i18n.language),
        })}
      </span>
      <button
        type="button"
        className="lt-link-button"
        onClick={() => setNotice(null)}
      >
        {t("diskSpace.dismiss")}
      </button>
    </div>
  );
}
