import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import type { LibraryImportProgressEvent } from "./desktopApi";
import { getPendingClipLabel, type PendingLibraryAssetSummary } from "./pendingAudioImports";

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
  assets: PendingLibraryAssetSummary[];
  folders: string[];
  isLoading: boolean;
  isImporting: boolean;
  importProgress: LibraryImportProgressEvent | null;
  deletingFilePath: string | null;
  canImport: boolean;
  dragTargetFolderPath?: string | null;
  onPointerDragStart?: (args: {
    payload: Array<{ file_path: string; durationSeconds: number }>;
    origin: { x: number; y: number };
    current: { x: number; y: number };
  }) => void;
  onLocateAsset?: (filePath: string) => void;
  onImport: () => void;
  onCreateFolder: () => void;
  onMoveAssetsToFolder: (filePaths: string[], folderPath: string | null) => void;
  onRenameFolder: (folderPath: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  onDeleteRequested: (assets: PendingLibraryAssetSummary[]) => void;
};

function formatAssetDuration(durationSeconds: number) {
  const safeDuration = Math.max(0, durationSeconds);
  const minutes = Math.floor(safeDuration / 60);
  const seconds = Math.floor(safeDuration % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function LibrarySidebarPanel({
  assets,
  folders,
  isLoading,
  isImporting,
  importProgress,
  deletingFilePath,
  canImport,
  dragTargetFolderPath,
  onPointerDragStart,
  onLocateAsset,
  onImport,
  onCreateFolder,
  onMoveAssetsToFolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteRequested,
}: LibrarySidebarPanelProps) {
  const { t } = useTranslation();
  const [selectedAssetPaths, setSelectedAssetPaths] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  // Persisted set of folder paths the user has collapsed. We store only
  // the collapsed ones so freshly-created folders default to expanded
  // without having to seed them. The empty string represents the root
  // group. Persistence is plain localStorage — Zustand would be
  // overkill for a single boolean per folder.
  const [collapsedFolderPaths, setCollapsedFolderPaths] = useState<
    Set<string>
  >(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem(
        "libretracks.library.collapsedFolders",
      );
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "libretracks.library.collapsedFolders",
        JSON.stringify(Array.from(collapsedFolderPaths)),
      );
    } catch {
      // Quota / private-mode → just lose persistence this session.
    }
  }, [collapsedFolderPaths]);
  const setFolderCollapsed = useCallback(
    (folderPath: string, collapsed: boolean) => {
      setCollapsedFolderPaths((current) => {
        const isCurrentlyCollapsed = current.has(folderPath);
        if (isCurrentlyCollapsed === collapsed) return current;
        const next = new Set(current);
        if (collapsed) {
          next.add(folderPath);
        } else {
          next.delete(folderPath);
        }
        return next;
      });
    },
    [],
  );
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);

  useEffect(() => {
    setSelectedAssetPaths((current) => {
      const filtered = current.filter((filePath) => assets.some((asset) => asset.filePath === filePath));
      if (filtered.length === 0) {
        selectionAnchorRef.current = null;
      } else if (
        selectionAnchorRef.current &&
        !assets.some((asset) => asset.filePath === selectionAnchorRef.current)
      ) {
        selectionAnchorRef.current = null;
      }
      return filtered;
    });
  }, [assets]);

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
    const assetsByFolder = new Map<string, PendingLibraryAssetSummary[]>();

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

  const updateAssetSelection = (asset: PendingLibraryAssetSummary, isToggleSelection: boolean) => {
    setSelectedAssetPaths((current) => {
      if (!isToggleSelection) {
        return [asset.filePath];
      }

      return current.includes(asset.filePath)
        ? current.filter((filePath) => filePath !== asset.filePath)
        : [...current, asset.filePath];
    });
    selectionAnchorRef.current = asset.filePath;
  };

  const applyRangeSelection = (
    asset: PendingLibraryAssetSummary,
    groupAssets: PendingLibraryAssetSummary[],
  ) => {
    const anchor = selectionAnchorRef.current;
    const anchorIndex = anchor
      ? groupAssets.findIndex((candidate) => candidate.filePath === anchor)
      : -1;
    const targetIndex = groupAssets.findIndex(
      (candidate) => candidate.filePath === asset.filePath,
    );

    // If anchor is missing or in a different group, treat as plain single select
    // and seed the anchor with the current click.
    if (anchorIndex < 0 || targetIndex < 0) {
      setSelectedAssetPaths([asset.filePath]);
      selectionAnchorRef.current = asset.filePath;
      return;
    }

    const [start, end] =
      anchorIndex <= targetIndex
        ? [anchorIndex, targetIndex]
        : [targetIndex, anchorIndex];
    const rangePaths = groupAssets
      .slice(start, end + 1)
      .map((candidate) => candidate.filePath);
    setSelectedAssetPaths(rangePaths);
    // Anchor stays put across range extensions.
  };

  const handleAssetSelect = (
    event: MouseEvent<HTMLDivElement>,
    asset: PendingLibraryAssetSummary,
    groupAssets: PendingLibraryAssetSummary[],
  ) => {
    if (event.shiftKey) {
      applyRangeSelection(asset, groupAssets);
      return;
    }
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

  const assetContextMenu = (asset: PendingLibraryAssetSummary) => {
    if (asset.isPending) {
      return [];
    }

    const contextAssets = selectedAssetPathSet.has(asset.filePath) ? selectedAssets : [asset];

    const actions: ContextMenuAction[] = [
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

    if (asset.isMissing && onLocateAsset) {
      actions.unshift({
        label: "Localizar archivo...",
        onSelect: () => onLocateAsset(asset.filePath),
      });
    }

    return actions;
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

  const handleAssetKeyDown = (event: KeyboardEvent<HTMLDivElement>, asset: PendingLibraryAssetSummary) => {
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

  const handleAssetPointerDown = (event: ReactPointerEvent<HTMLDivElement>, asset: PendingLibraryAssetSummary) => {
    if (event.button !== 0 || asset.isPending) {
      return;
    }

    const draggedAssets =
      selectedAssetPathSet.has(asset.filePath) && selectedAssetPaths.length > 1
        ? assets.filter((candidate) => selectedAssetPathSet.has(candidate.filePath))
        : [asset];
    const dragPayload = draggedAssets.map((draggedAsset) => ({
      file_path: draggedAsset.filePath,
      durationSeconds: draggedAsset.durationSeconds,
    }));
    onPointerDragStart?.({
      payload: dragPayload,
      origin: { x: event.clientX, y: event.clientY },
      current: { x: event.clientX, y: event.clientY },
    });
  };

  const handleAssetMouseDown = (event: MouseEvent<HTMLDivElement>, asset: PendingLibraryAssetSummary) => {
    if (
      typeof window !== "undefined" &&
      typeof (window as Window & { PointerEvent?: unknown }).PointerEvent === "function"
    ) {
      return;
    }

    if (event.button !== 0 || asset.isPending) {
      return;
    }

    const draggedAssets =
      selectedAssetPathSet.has(asset.filePath) && selectedAssetPaths.length > 1
        ? assets.filter((candidate) => selectedAssetPathSet.has(candidate.filePath))
        : [asset];
    const dragPayload = draggedAssets.map((draggedAsset) => ({
      file_path: draggedAsset.filePath,
      durationSeconds: draggedAsset.durationSeconds,
    }));

    onPointerDragStart?.({
      payload: dragPayload,
      origin: { x: event.clientX, y: event.clientY },
      current: { x: event.clientX, y: event.clientY },
    });
  };

  const renderAssetRows = (groupAssets: PendingLibraryAssetSummary[]) => {
    return groupAssets.length ? (
      <div className="lt-library-asset-list" role="list" aria-label={t("library.assetListAria")}>
        {groupAssets.map((asset) => {
          const isSelected = selectedAssetPathSet.has(asset.filePath);
          const isPending = Boolean(asset.isPending);

          return (
            <div key={asset.filePath} role="listitem" className={`lt-library-asset-row ${isSelected ? "is-selected" : ""}`}>
              <div
                className={`lt-library-asset ${asset.isMissing ? "is-missing" : ""} ${isPending ? "is-pending" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={asset.fileName}
                aria-pressed={isSelected}
                title={asset.fileName}
                onClick={(event) => handleAssetSelect(event, asset, groupAssets)}
                onMouseDown={(event) => handleAssetMouseDown(event, asset)}
                onPointerDown={(event) => handleAssetPointerDown(event, asset)}
                onContextMenu={(event) => {
                  if (isPending) {
                    event.preventDefault();
                    return;
                  }

                  if (!selectedAssetPathSet.has(asset.filePath)) {
                    updateAssetSelection(asset, event.ctrlKey || event.metaKey);
                  }
                  openContextMenu(event, asset.fileName, assetContextMenu(asset));
                }}
                onKeyDown={(event) => handleAssetKeyDown(event, asset)}
              >
                <span className="lt-library-asset-icon material-symbols-outlined">
                  {isPending ? "hourglass_top" : asset.isMissing ? "warning" : "music_note"}
                </span>
                <span className="lt-library-asset-copy" title={asset.fileName}>{asset.fileName}</span>
                <span className="lt-library-asset-duration">
                  {isPending ? getPendingClipLabel(asset.pendingStatus ?? "queued", t) : formatAssetDuration(asset.durationSeconds)}
                </span>
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
            <details
              className="lt-library-root-group"
              open={!collapsedFolderPaths.has("")}
              onToggle={(event) =>
                setFolderCollapsed(
                  "",
                  !(event.currentTarget as HTMLDetailsElement).open,
                )
              }
            >
              <summary
                className={`lt-library-folder-summary ${dragTargetFolderPath === null ? "is-drag-target" : ""}`}
                data-library-folder-drop-target="true"
                data-library-folder-path=""
                onContextMenu={(event) => openContextMenu(event, t("library.rootFolder"), folderContextMenu(null))}
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
              <details
                key={group.folderPath}
                className="lt-library-folder-group"
                open={!collapsedFolderPaths.has(group.folderPath)}
                onToggle={(event) =>
                  setFolderCollapsed(
                    group.folderPath,
                    !(event.currentTarget as HTMLDetailsElement).open,
                  )
                }
              >
                <summary
                  className={`lt-library-folder-summary ${dragTargetFolderPath === group.folderPath ? "is-drag-target" : ""}`}
                  data-library-folder-drop-target="true"
                  data-library-folder-path={group.folderPath}
                  onContextMenu={(event) => openContextMenu(event, group.folderPath, folderContextMenu(group.folderPath))}
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
