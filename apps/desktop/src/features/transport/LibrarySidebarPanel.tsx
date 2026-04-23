import { useEffect, useState, type DragEvent, type MouseEvent } from "react";

import type { LibraryAssetSummary, LibraryImportProgressEvent } from "./desktopApi";

const LIBRARY_ASSET_DRAG_MIME = "application/libretracks-library-assets";

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
  const [selectedAssetPaths, setSelectedAssetPaths] = useState<string[]>([]);

  useEffect(() => {
    setSelectedAssetPaths((current) => current.filter((filePath) => assets.some((asset) => asset.filePath === filePath)));
  }, [assets]);

  const handleAssetSelect = (event: MouseEvent<HTMLButtonElement>, asset: LibraryAssetSummary) => {
    const isToggleSelection = event.ctrlKey || event.metaKey;

    setSelectedAssetPaths((current) => {
      if (!isToggleSelection) {
        return [asset.filePath];
      }

      return current.includes(asset.filePath)
        ? current.filter((filePath) => filePath !== asset.filePath)
        : [...current, asset.filePath];
    });
  };

  const handleAssetDragStart = (event: DragEvent<HTMLButtonElement>, asset: LibraryAssetSummary) => {
    const draggedAssets =
      selectedAssetPaths.includes(asset.filePath) && selectedAssetPaths.length > 1
        ? assets.filter((candidate) => selectedAssetPaths.includes(candidate.filePath))
        : [asset];
    const payload = JSON.stringify(
      draggedAssets.map((draggedAsset) => ({
        file_path: draggedAsset.filePath,
        durationSeconds: draggedAsset.durationSeconds,
      })),
    );

    if (!selectedAssetPaths.includes(asset.filePath) || selectedAssetPaths.length <= 1) {
      setSelectedAssetPaths([asset.filePath]);
    }

    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(LIBRARY_ASSET_DRAG_MIME, payload);
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
        <span>
          {selectedAssetPaths.length > 1
            ? `${selectedAssetPaths.length} selected`
            : canImport
              ? "Ready"
              : "Open or create a session"}
        </span>
      </div>

      {isImporting && importProgress ? (
        <div className="lt-library-progress" aria-live="polite">
          <div className="lt-library-progress-copy is-spinner-only">
            <span className="lt-library-progress-spinner" aria-hidden="true" />
            <strong>{importProgress.message}</strong>
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
                className={`lt-library-asset-row ${selectedAssetPaths.includes(asset.filePath) ? "is-selected" : ""}`}
              >
                <button
                  type="button"
                  className="lt-library-asset"
                  aria-label={asset.fileName}
                  aria-pressed={selectedAssetPaths.includes(asset.filePath)}
                  title={asset.fileName}
                  draggable
                  onClick={(event) => handleAssetSelect(event, asset)}
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
