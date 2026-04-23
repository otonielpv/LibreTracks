import type { DragEvent } from "react";

import type { LibraryAssetSummary, LibraryImportProgressEvent } from "./desktopApi";

type LibrarySidebarPanelProps = {
  assets: LibraryAssetSummary[];
  isLoading: boolean;
  isImporting: boolean;
  importProgress: LibraryImportProgressEvent | null;
  deletingFilePath: string | null;
  canImport: boolean;
  onImport: () => void;
  onDelete: (filePath: string, fileName: string) => void;
};

function formatAssetDuration(durationSeconds: number) {
  const safeDuration = Math.max(0, durationSeconds);
  const minutes = Math.floor(safeDuration / 60);
  const seconds = Math.floor(safeDuration % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function LibrarySidebarPanel({
  assets,
  isLoading,
  isImporting,
  importProgress,
  deletingFilePath,
  canImport,
  onImport,
  onDelete,
}: LibrarySidebarPanelProps) {
  const handleAssetDragStart = (event: DragEvent<HTMLButtonElement>, asset: LibraryAssetSummary) => {
    const payload = JSON.stringify({
      file_path: asset.filePath,
      durationSeconds: asset.durationSeconds,
    });

    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/libretracks-library-asset", payload);
    event.dataTransfer.setData("text/plain", asset.filePath);
  };

  return (
    <aside className="lt-library-panel" aria-label="Library panel">
      <div className="lt-library-panel-header">
        <div>
          <span className="lt-library-panel-eyebrow">Session Assets</span>
          <h2>Library</h2>
        </div>
        <button
          type="button"
          className="lt-library-import-button"
          onClick={onImport}
          disabled={!canImport || isImporting}
        >
          <span className="material-symbols-outlined">audio_file</span>
          {isImporting ? "Importing..." : "Import audio"}
        </button>
      </div>

      <div className="lt-library-panel-meta" aria-live="polite">
        <span>{assets.length} assets</span>
        <span>{isImporting && importProgress ? `${Math.round(importProgress.percent)}%` : canImport ? "Ready" : "Open or create a session"}</span>
      </div>

      {isImporting && importProgress ? (
        <div className="lt-library-progress" aria-live="polite">
          <div className="lt-library-progress-copy">
            <strong>{importProgress.message}</strong>
            <span>{Math.max(0, Math.min(100, Math.round(importProgress.percent)))}%</span>
          </div>
          <div className="lt-library-progress-bar" aria-hidden="true">
            <div
              className="lt-library-progress-fill"
              style={{ width: `${Math.max(0, Math.min(100, importProgress.percent))}%` }}
            />
          </div>
        </div>
      ) : null}

      <div className="lt-library-panel-body">
        {isLoading ? <p className="lt-library-panel-empty">Loading library assets...</p> : null}

        {!isLoading && !assets.length ? (
          <p className="lt-library-panel-empty">
            Import WAV files to build the library before arranging them on the timeline.
          </p>
        ) : null}

        {!isLoading && assets.length ? (
          <div className="lt-library-asset-list" role="list" aria-label="Library assets">
            {assets.map((asset) => (
              <div
                key={asset.filePath}
                role="listitem"
                className="lt-library-asset-row"
              >
                <button
                  type="button"
                  className="lt-library-asset"
                  aria-label={asset.fileName}
                  title={asset.fileName}
                  draggable
                  onDragStart={(event) => handleAssetDragStart(event, asset)}
                >
                  <span className="lt-library-asset-icon material-symbols-outlined">music_note</span>
                  <span className="lt-library-asset-copy">
                    <strong>{asset.fileName}</strong>
                    <small>
                      {formatAssetDuration(asset.durationSeconds)}
                      {asset.detectedBpm ? ` | ${asset.detectedBpm.toFixed(1)} BPM` : ""}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className="lt-library-asset-delete"
                  aria-label={`Delete ${asset.fileName}`}
                  disabled={deletingFilePath === asset.filePath}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(asset.filePath, asset.fileName);
                  }}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
