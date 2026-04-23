import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import type { LibraryAssetSummary, LibraryImportProgressEvent } from "./desktopApi";

const LIBRARY_ASSET_DRAG_MIME = "application/libretracks-library-assets";

type LibrarySidebarPanelProps = {
  assets: LibraryAssetSummary[];
  isLoading: boolean;
  isImporting: boolean;
  importProgress: LibraryImportProgressEvent | null;
  deletingFilePath: string | null;
  canImport: boolean;
  onDragAssetsStart?: (assets: Array<{ file_path: string; durationSeconds: number }>) => void;
  onDragAssetsEnd?: () => void;
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
  onDragAssetsStart,
  onDragAssetsEnd,
  onImport,
  onDelete,
}: LibrarySidebarPanelProps) {
  const [selectedAssetPaths, setSelectedAssetPaths] = useState<string[]>([]);
  const dragPreviewElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setSelectedAssetPaths((current) => current.filter((filePath) => assets.some((asset) => asset.filePath === filePath)));
  }, [assets]);

  useEffect(() => {
    return () => {
      dragPreviewElementRef.current?.remove();
      dragPreviewElementRef.current = null;
    };
  }, []);

  const updateAssetSelection = (asset: LibraryAssetSummary, isToggleSelection: boolean) => {
    setSelectedAssetPaths((current) => {
      if (!isToggleSelection) {
        return [asset.filePath];
      }

      return current.includes(asset.filePath)
        ? current.filter((filePath) => filePath !== asset.filePath)
        : [...current, asset.filePath];
    });
  };

  const handleAssetSelect = (event: MouseEvent<HTMLDivElement>, asset: LibraryAssetSummary) => {
    updateAssetSelection(asset, event.ctrlKey || event.metaKey);
  };

  const handleAssetKeyDown = (event: KeyboardEvent<HTMLDivElement>, asset: LibraryAssetSummary) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    updateAssetSelection(asset, event.ctrlKey || event.metaKey);
  };

  const handleAssetDragStart = (event: DragEvent<HTMLDivElement>, asset: LibraryAssetSummary) => {
    const draggedAssets =
      selectedAssetPaths.includes(asset.filePath) && selectedAssetPaths.length > 1
        ? assets.filter((candidate) => selectedAssetPaths.includes(candidate.filePath))
        : [asset];
    const dragPayload = draggedAssets.map((draggedAsset) => ({
      file_path: draggedAsset.filePath,
      durationSeconds: draggedAsset.durationSeconds,
    }));
    const payload = JSON.stringify(dragPayload);

    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(LIBRARY_ASSET_DRAG_MIME, payload);
    event.dataTransfer.setData("text/plain", dragPayload.map((item) => item.file_path).join("\n"));

    dragPreviewElementRef.current?.remove();
    dragPreviewElementRef.current = null;

    const dragPreviewElement = event.currentTarget.cloneNode(true);
    if (dragPreviewElement instanceof HTMLElement) {
      dragPreviewElement.style.position = "fixed";
      dragPreviewElement.style.top = "-10000px";
      dragPreviewElement.style.left = "-10000px";
      dragPreviewElement.style.width = `${Math.round(event.currentTarget.getBoundingClientRect().width)}px`;
      dragPreviewElement.style.pointerEvents = "none";
      dragPreviewElement.style.zIndex = "9999";
      dragPreviewElement.style.opacity = "0.96";
      document.body.appendChild(dragPreviewElement);
      dragPreviewElementRef.current = dragPreviewElement;
      if (typeof event.dataTransfer.setDragImage === "function") {
        event.dataTransfer.setDragImage(dragPreviewElement, 22, 18);
      }
    }
    onDragAssetsStart?.(dragPayload);
  };

  const handleAssetDragEnd = () => {
    dragPreviewElementRef.current?.remove();
    dragPreviewElementRef.current = null;
    onDragAssetsEnd?.();
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
                <div
                  className="lt-library-asset"
                  role="button"
                  tabIndex={0}
                  aria-label={asset.fileName}
                  aria-pressed={selectedAssetPaths.includes(asset.filePath)}
                  title={asset.fileName}
                  draggable
                  onClick={(event) => handleAssetSelect(event, asset)}
                  onKeyDown={(event) => handleAssetKeyDown(event, asset)}
                  onDragEnd={handleAssetDragEnd}
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
                </div>
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
