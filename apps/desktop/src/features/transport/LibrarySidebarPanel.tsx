import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";

import type { LibraryAssetSummary, LibraryImportProgressEvent } from "./desktopApi";

const LIBRARY_ASSET_DRAG_MIME = "application/libretracks-library-assets";
const INTERNAL_DRAG_START_EVENT = "libretracks-internal-drag-start";
const INTERNAL_DRAG_END_EVENT = "libretracks-internal-drag-end";
const ROOT_GROUP_ID = "__root__";

type ContextMenuAction = {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

type ContextMenuState = {
  x: number;
  y: number;
  title: string;
  actions: ContextMenuAction[];
} | null;

type LibrarySidebarPanelProps = {
  assets: LibraryAssetSummary[];
  folders: string[];
  isLoading: boolean;
  isImporting: boolean;
  importProgress: LibraryImportProgressEvent | null;
  deletingFilePath: string | null;
  canImport: boolean;
  onDragAssetsStart?: (assets: Array<{ file_path: string; durationSeconds: number }>) => void;
  onDragAssetsEnd?: () => void;
  onImport: () => void;
  onCreateFolder: () => void;
  onMoveAssetsToFolder: (filePaths: string[], folderPath: string | null) => void;
  onRenameFolder: (folderPath: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  onDeleteRequested: (assets: LibraryAssetSummary[]) => void;
};

function formatAssetDuration(durationSeconds: number) {
  const safeDuration = Math.max(0, durationSeconds);
  const minutes = Math.floor(safeDuration / 60);
  const seconds = Math.floor(safeDuration % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatAssetBpm(detectedBpm: number | null | undefined) {
  return detectedBpm ? `${detectedBpm.toFixed(1)} BPM` : "-- BPM";
}

function readDraggedLibraryFilePaths(dataTransfer: DataTransfer | null) {
  const payload = dataTransfer?.getData(LIBRARY_ASSET_DRAG_MIME);
  if (!payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload) as Array<{ file_path?: string }>;
    return parsed
      .map((entry) => entry.file_path)
      .filter((filePath): filePath is string => Boolean(filePath));
  } catch {
    return [];
  }
}

export function LibrarySidebarPanel({
  assets,
  folders,
  isLoading,
  isImporting,
  importProgress,
  deletingFilePath,
  canImport,
  onDragAssetsStart,
  onDragAssetsEnd,
  onImport,
  onCreateFolder,
  onMoveAssetsToFolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteRequested,
}: LibrarySidebarPanelProps) {
  const { t } = useTranslation();
  const [selectedAssetPaths, setSelectedAssetPaths] = useState<string[]>([]);
  const [dragTargetGroupId, setDragTargetGroupId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const dragPreviewElementRef = useRef<HTMLElement | null>(null);
  const activeDraggedFilePathsRef = useRef<string[]>([]);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const handleFolderDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  useEffect(() => {
    setSelectedAssetPaths((current) => current.filter((filePath) => assets.some((asset) => asset.filePath === filePath)));
  }, [assets]);

  useEffect(() => {
    return () => {
      dragPreviewElementRef.current?.remove();
      dragPreviewElementRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handleClose = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node | null)) {
        return;
      }

      setContextMenu(null);
    };
    const handleBlur = () => setContextMenu(null);
    window.addEventListener("pointerdown", handleClose);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("pointerdown", handleClose);
      window.removeEventListener("blur", handleBlur);
    };
  }, [contextMenu]);

  const selectedAssetPathSet = useMemo(() => new Set(selectedAssetPaths), [selectedAssetPaths]);
  const selectedAssets = useMemo(
    () => assets.filter((asset) => selectedAssetPathSet.has(asset.filePath)),
    [assets, selectedAssetPathSet],
  );

  const rootAssets = useMemo(
    () => assets.filter((asset) => !asset.folderPath),
    [assets],
  );
  const folderGroups = useMemo(() => {
    const assetsByFolder = new Map<string, LibraryAssetSummary[]>();

    for (const folderPath of folders) {
      assetsByFolder.set(folderPath, []);
    }

    for (const asset of assets) {
      if (!asset.folderPath) {
        continue;
      }

      const groupedAssets = assetsByFolder.get(asset.folderPath) ?? [];
      groupedAssets.push(asset);
      assetsByFolder.set(asset.folderPath, groupedAssets);
    }

    return [...assetsByFolder.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([folderPath, groupedAssets]) => ({
        folderPath,
        assets: groupedAssets.sort((left, right) => left.fileName.localeCompare(right.fileName)),
      }));
  }, [assets, folders]);

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

  const openContextMenu = (
    event: MouseEvent<HTMLElement>,
    title: string,
    actions: ContextMenuAction[],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      title,
      actions,
    });
  };

  const resolveDraggedFilePaths = (dataTransfer: DataTransfer | null) => {
    const payload = readDraggedLibraryFilePaths(dataTransfer);
    if (payload.length) {
      return payload;
    }

    return activeDraggedFilePathsRef.current;
  };

  const assetContextMenu = (asset: LibraryAssetSummary) => {
    const contextAssets = selectedAssetPathSet.has(asset.filePath) ? selectedAssets : [asset];

    return [
      {
        label: contextAssets.length > 1
          ? t("library.deleteAssets", { count: contextAssets.length })
          : t("library.deleteAsset", { name: asset.fileName }),
        disabled: contextAssets.some((candidate) => deletingFilePath === candidate.filePath),
        onSelect: () => onDeleteRequested(contextAssets),
      },
      {
        label: asset.folderPath ? t("library.moveToRoot") : t("library.moveToRootDisabled"),
        disabled: !asset.folderPath,
        onSelect: () => onMoveAssetsToFolder(contextAssets.map((candidate) => candidate.filePath), null),
      },
    ];
  };

  const folderContextMenu = (folderPath: string | null) => {
    if (!folderPath) {
      return [
        {
          label: t("library.createFolder"),
          onSelect: onCreateFolder,
        },
      ];
    }

    return [
      {
        label: t("library.renameFolder"),
        onSelect: () => onRenameFolder(folderPath),
      },
      {
        label: t("library.deleteFolder"),
        onSelect: () => onDeleteFolder(folderPath),
      },
    ];
  };

  const handleAssetKeyDown = (event: KeyboardEvent<HTMLDivElement>, asset: LibraryAssetSummary) => {
    if (event.key === "Delete" && selectedAssets.length > 0) {
      event.preventDefault();
      onDeleteRequested(selectedAssets);
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    updateAssetSelection(asset, event.ctrlKey || event.metaKey);
  };

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Delete" || selectedAssets.length === 0) {
      return;
    }

    event.preventDefault();
    onDeleteRequested(selectedAssets);
  };

  const handleAssetDragStart = (event: DragEvent<HTMLDivElement>, asset: LibraryAssetSummary) => {
    const draggedAssets =
      selectedAssetPathSet.has(asset.filePath) && selectedAssetPaths.length > 1
        ? assets.filter((candidate) => selectedAssetPathSet.has(candidate.filePath))
        : [asset];
    const dragPayload = draggedAssets.map((draggedAsset) => ({
      file_path: draggedAsset.filePath,
      durationSeconds: draggedAsset.durationSeconds,
    }));
    const payload = JSON.stringify(dragPayload);
    activeDraggedFilePathsRef.current = dragPayload.map((item) => item.file_path);

    event.dataTransfer.effectAllowed = "copyMove";
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

    window.dispatchEvent(
      new CustomEvent(INTERNAL_DRAG_START_EVENT, {
        detail: {
          assetCount: dragPayload.length,
          filePaths: dragPayload.map((item) => item.file_path),
          types: Array.from(event.dataTransfer.types ?? []),
          effectAllowed: event.dataTransfer.effectAllowed,
        },
      }),
    );

    onDragAssetsStart?.(dragPayload);
  };

  const handleAssetDragEnd = () => {
    dragPreviewElementRef.current?.remove();
    dragPreviewElementRef.current = null;
    activeDraggedFilePathsRef.current = [];
    setDragTargetGroupId(null);
    window.dispatchEvent(
      new CustomEvent(INTERNAL_DRAG_END_EVENT, {
        detail: { reason: "dragend" },
      }),
    );
    onDragAssetsEnd?.();
  };

  const handleGroupDragOver = (event: DragEvent<HTMLElement>, folderPath: string | null) => {
    const draggedFilePaths = resolveDraggedFilePaths(event.dataTransfer);
    if (!draggedFilePaths.length) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDragTargetGroupId(folderPath ?? ROOT_GROUP_ID);
  };

  const handleGroupDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setDragTargetGroupId(null);
  };

  const handleGroupDrop = (event: DragEvent<HTMLElement>, folderPath: string | null) => {
    const draggedFilePaths = resolveDraggedFilePaths(event.dataTransfer);
    if (!draggedFilePaths.length) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDragTargetGroupId(null);
    activeDraggedFilePathsRef.current = [];
    onMoveAssetsToFolder(draggedFilePaths, folderPath);
  };

  const renderAssetRows = (groupAssets: LibraryAssetSummary[]) => {
    return groupAssets.length ? (
      <div className="lt-library-asset-list" role="list" aria-label={t("library.assetListAria")}>
        {groupAssets.map((asset) => {
          const isSelected = selectedAssetPathSet.has(asset.filePath);

          return (
            <div key={asset.filePath} role="listitem" className={`lt-library-asset-row ${isSelected ? "is-selected" : ""}`}>
              <div
                className="lt-library-asset"
                role="button"
                tabIndex={0}
                aria-label={asset.fileName}
                aria-pressed={isSelected}
                title={asset.fileName}
                draggable
                onClick={(event) => handleAssetSelect(event, asset)}
                onContextMenu={(event) => {
                  if (!selectedAssetPathSet.has(asset.filePath)) {
                    updateAssetSelection(asset, event.ctrlKey || event.metaKey);
                  }
                  openContextMenu(event, asset.fileName, assetContextMenu(asset));
                }}
                onKeyDown={(event) => handleAssetKeyDown(event, asset)}
                onDragEnd={handleAssetDragEnd}
                onDragStart={(event) => handleAssetDragStart(event, asset)}
              >
                <span className="lt-library-asset-icon material-symbols-outlined">music_note</span>
                <span className="lt-library-asset-copy" title={asset.fileName}>{asset.fileName}</span>
                <span className="lt-library-asset-bpm">{formatAssetBpm(asset.detectedBpm)}</span>
                <span className="lt-library-asset-duration">{formatAssetDuration(asset.durationSeconds)}</span>
              </div>
            </div>
          );
        })}
      </div>
    ) : (
      <p className="lt-library-folder-empty">{t("library.emptyFolder")}</p>
    );
  };

  return (
    <aside className="lt-library-panel" aria-label={t("library.panelAria")}>
      <div className="lt-library-panel-header">
        <div>
          <span className="lt-library-panel-eyebrow">{t("library.eyebrow")}</span>
          <h2>{t("library.title")}</h2>
        </div>

        <div className="lt-library-panel-actions">
          <button
            type="button"
            className="lt-library-folder-button"
            onClick={onCreateFolder}
            disabled={!canImport || isImporting}
          >
            <span className="material-symbols-outlined">create_new_folder</span>
            {t("library.folderButton")}
          </button>
          <button
            type="button"
            className="lt-library-import-button"
            onClick={onImport}
            disabled={!canImport || isImporting}
          >
            <span className="material-symbols-outlined">audio_file</span>
            {isImporting ? t("library.importing") : t("library.importAudio")}
          </button>
        </div>
      </div>

      <div className="lt-library-panel-meta" aria-live="polite">
        <span>{t("library.assetsCount", { count: assets.length })}</span>
        <span>{t("library.foldersCount", { count: folders.length })}</span>
        <span>
          {selectedAssetPaths.length > 1
            ? t("library.selectedCount", { count: selectedAssetPaths.length })
            : canImport
              ? t("library.deleteHint")
              : t("library.openSessionHint")}
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

      <div className="lt-library-panel-body" onKeyDown={handlePanelKeyDown} tabIndex={0}>
        {isLoading ? <p className="lt-library-panel-empty">{t("library.loading")}</p> : null}

        {!isLoading && !assets.length && !folders.length ? (
          <p className="lt-library-panel-empty">
            {t("library.empty")}
          </p>
        ) : null}

        {!isLoading && (assets.length || folders.length) ? (
          <div className="lt-library-asset-groups">
            <details className="lt-library-root-group" open>
              <summary
                className={`lt-library-folder-summary ${dragTargetGroupId === ROOT_GROUP_ID ? "is-drag-target" : ""}`}
                onContextMenu={(event) => openContextMenu(event, t("library.rootFolder"), folderContextMenu(null))}
                onDragEnter={handleFolderDragEnter}
                onDragLeave={handleGroupDragLeave}
                onDragOver={(event) => handleGroupDragOver(event, null)}
                onDrop={(event) => handleGroupDrop(event, null)}
              >
                <span className="material-symbols-outlined">home_storage</span>
                <span className="lt-library-folder-copy">
                  <strong title={t("library.rootFolder")}>{t("library.rootFolder")}</strong>
                  <small>{t("library.assetsInFolder", { count: rootAssets.length })}</small>
                </span>
              </summary>
              <div className="lt-library-group-list">{renderAssetRows(rootAssets)}</div>
            </details>

            {folderGroups.map((group) => (
              <details key={group.folderPath} className="lt-library-folder-group" open>
                <summary
                  className={`lt-library-folder-summary ${dragTargetGroupId === group.folderPath ? "is-drag-target" : ""}`}
                  onContextMenu={(event) => openContextMenu(event, group.folderPath, folderContextMenu(group.folderPath))}
                  onDragEnter={handleFolderDragEnter}
                  onDragLeave={handleGroupDragLeave}
                  onDragOver={(event) => handleGroupDragOver(event, group.folderPath)}
                  onDrop={(event) => handleGroupDrop(event, group.folderPath)}
                >
                  <span className="material-symbols-outlined">folder</span>
                  <span className="lt-library-folder-copy">
                    <strong title={group.folderPath}>{group.folderPath}</strong>
                    <small>{t("library.assetsInFolder", { count: group.assets.length })}</small>
                  </span>
                </summary>
                <div className="lt-library-group-list">{renderAssetRows(group.assets)}</div>
              </details>
            ))}
          </div>
        ) : null}

        {contextMenu ? (
          <div
            className="lt-context-menu"
            ref={contextMenuRef}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <strong>{contextMenu.title}</strong>
            {contextMenu.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={action.disabled}
                onClick={() => {
                  setContextMenu(null);
                  action.onSelect();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
