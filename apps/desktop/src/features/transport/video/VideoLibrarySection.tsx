import { useTranslation } from "react-i18next";

import type { VideoAssetSummary } from "../desktopApi";
import { useVideoStore } from "./videoStore";

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The videos of the session library, under the audio. Their own list because
 * they live apart in `library.json` (see state/video_library.rs) and behave
 * differently: they are referenced in place, have a resolution and can be slow
 * to seek. Double-click (or the + button) puts one on the timeline at the
 * playhead.
 */
export function VideoLibrarySection() {
  const { t } = useTranslation();
  const assets = useVideoStore((state) => state.assets);
  const placeAtPlayhead = useVideoStore((state) => state.placeAtPlayhead);
  const addFromDevice = useVideoStore((state) => state.addFromDevice);
  if (!assets.length && !addFromDevice) return null;

  const describe = (asset: VideoAssetSummary) =>
    [
      asset.fileName,
      `${asset.info.width}×${asset.info.height}`,
      asset.info.fps ? `${Math.round(asset.info.fps * 100) / 100} fps` : null,
      asset.info.codec,
      asset.hasSlowSeeks ? t("transport.video.slowSeeks") : null,
      asset.unplayableReason ? t("transport.video.unplayableHere") : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="lt-library-video-section">
      <div className="lt-library-video-heading">
        <span className="material-symbols-outlined" aria-hidden="true">
          movie
        </span>
        {t("transport.video.librarySection")}
        {addFromDevice ? (
          <>
            <button
              type="button"
              className="lt-library-video-add"
              data-lt-native-touch
              aria-label={t("transport.video.addFromGallery")}
              title={t("transport.video.addFromGallery")}
              onClick={() => addFromDevice("gallery")}
            >
              <span className="material-symbols-outlined">photo_library</span>
            </button>
            <button
              type="button"
              className="lt-library-video-add"
              data-lt-native-touch
              aria-label={t("transport.video.addFromFiles")}
              title={t("transport.video.addFromFiles")}
              onClick={() => addFromDevice("files")}
            >
              <span className="material-symbols-outlined">folder_open</span>
            </button>
          </>
        ) : null}
      </div>
      <div
        className="lt-library-asset-list"
        role="list"
        aria-label={t("transport.video.librarySection")}
      >
        {assets.map((asset) => (
          <div key={asset.filePath} role="listitem" className="lt-library-asset-row">
            <div
              className={`lt-library-asset lt-library-video-asset ${asset.isMissing ? "is-missing" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={asset.fileName}
              title={describe(asset)}
              onDoubleClick={() => placeAtPlayhead?.(asset)}
              onKeyDown={(event) => {
                if (event.key === "Enter") placeAtPlayhead?.(asset);
              }}
            >
              <span className="lt-library-asset-icon material-symbols-outlined">
                {asset.isMissing ? "warning" : "movie"}
              </span>
              <span className="lt-library-asset-duration">
                {formatDuration(asset.info.durationSeconds)}
              </span>
              <span className="lt-library-asset-copy">{asset.fileName}</span>
              {asset.unplayableReason ? (
                <span
                  className="lt-library-video-warning material-symbols-outlined"
                  title={asset.unplayableReason}
                  aria-label={t("transport.video.unplayableHere")}
                >
                  block
                </span>
              ) : null}
              {asset.hasSlowSeeks ? (
                <span
                  className="lt-library-video-warning material-symbols-outlined"
                  title={t("transport.video.slowSeeks")}
                  aria-label={t("transport.video.slowSeeks")}
                >
                  speed
                </span>
              ) : null}
              {placeAtPlayhead && !asset.isMissing ? (
                <button
                  type="button"
                  className="lt-library-video-add"
                  aria-label={t("transport.video.placeAtPlayhead")}
                  title={t("transport.video.placeAtPlayhead")}
                  onClick={(event) => {
                    event.stopPropagation();
                    placeAtPlayhead(asset);
                  }}
                >
                  <span className="material-symbols-outlined">add</span>
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
