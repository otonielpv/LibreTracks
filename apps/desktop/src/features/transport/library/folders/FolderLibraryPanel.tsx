import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { DRAG_THRESHOLD_PX } from "../../constants";
import {
  isMobileApp,
  listLibraryDir,
  pickLibraryPlace,
  type LibraryDirEntry,
} from "../../desktopApi";
import { clientToZoomedCoords } from "../../../../shared/uiZoom";
import type { BrowserDrop } from "./browserDrop";
import { audioPathsOf, filterEntries, placeLabel } from "./libraryPlaces";
import { useFolderTree, type FolderListing } from "./useFolderTree";
import type { LibrarySettings } from "./useLibrarySettings";
import "./folderLibrary.css";

const SESSION_OPEN_KEY = "lt.folderLibrary.sessionOpen";

type DragItem =
  | { kind: "files"; paths: string[]; label: string }
  | { kind: "folder"; path: string; name: string };

type PendingDrag = {
  item: DragItem;
  originX: number;
  originY: number;
  dragging: boolean;
  x: number;
  y: number;
};

type FolderLibraryPanelProps = {
  settings: LibrarySettings;
  browserDrop: BrowserDrop;
  /** The classic library (the session's imported assets), shown under the
   * places as "In this session". */
  sessionPanel: ReactNode;
  sessionAssetCount: number;
};

/** Desktop has room for both, so the session's audio starts open. On a phone
 * opening it takes the whole library (see the CSS), so it starts folded and
 * the disk folders are what shows first. */
function readSessionOpen(): boolean {
  const fallback = !isMobileApp;
  try {
    const saved = window.localStorage.getItem(SESSION_OPEN_KEY);
    return saved === null ? fallback : saved !== "0";
  } catch {
    return fallback;
  }
}

function writeSessionOpen(open: boolean) {
  try {
    window.localStorage.setItem(SESSION_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Per-viewer convenience only: nothing to do if storage is unavailable.
  }
}

const ENTRY_ICONS: Record<LibraryDirEntry["kind"], string> = {
  folder: "folder",
  audio: "audio_file",
  video: "movie",
  package: "inventory_2",
};

/**
 * Library of disk folders, like the "Places" of Ableton's browser: the user
 * adds folders of their disk and drags audio out of them onto the timeline.
 * Dragging a folder makes one song named after it. Files dropped this way are
 * imported by reference, exactly like files dropped from the OS file manager.
 */
export function FolderLibraryPanel({
  settings,
  browserDrop,
  sessionPanel,
  sessionAssetCount,
}: FolderLibraryPanelProps) {
  const { t } = useTranslation();
  const tree = useFolderTree();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [sessionOpen, setSessionOpen] = useState(readSessionOpen);
  const [drag, setDrag] = useState<PendingDrag | null>(null);
  const dragRef = useRef<PendingDrag | null>(null);
  dragRef.current = drag;

  const handleAddPlace = useCallback(async () => {
    const picked = await pickLibraryPlace();
    if (picked) {
      await settings.addPlace(picked);
    }
  }, [settings]);

  const toggleSession = () => {
    setSessionOpen((current) => {
      writeSessionOpen(!current);
      return !current;
    });
  };

  /** The audio of a folder: from its listing when open, else read it now. */
  const folderAudio = useCallback(
    async (path: string) => {
      const listing = tree.listings.get(path);
      const entries =
        listing?.status === "ready"
          ? listing.entries
          : await listLibraryDir(path).catch(() => [] as LibraryDirEntry[]);
      return audioPathsOf(entries);
    },
    [tree.listings],
  );

  // Window-level listeners while a row is pressed: the drag leaves the panel.
  useEffect(() => {
    if (!drag) return;

    const handleMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const moved = Math.hypot(event.clientX - current.originX, event.clientY - current.originY);
      const dragging = current.dragging || moved >= DRAG_THRESHOLD_PX;
      setDrag({
        ...current,
        dragging,
        x: event.clientX,
        y: event.clientY,
      });
      // Show on the timeline where it would land.
      if (dragging) browserDrop.previewAt(current.item, event.clientX, event.clientY);
    };

    const handleUp = (event: PointerEvent) => {
      const current = dragRef.current;
      setDrag(null);
      browserDrop.clearPreview();
      if (!current?.dragging) return;
      const { item } = current;
      if (item.kind === "files") {
        browserDrop.dropPathsAt(item.paths, event.clientX, event.clientY);
        return;
      }
      const { clientX, clientY, ctrlKey, metaKey } = event;
      void folderAudio(item.path).then((audioPaths) => {
        browserDrop.dropFolderAt({
          folderName: item.name,
          audioPaths,
          clientX,
          clientY,
          ctrlKey,
          metaKey,
        });
      });
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrag(null);
        browserDrop.clearPreview();
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("keydown", handleKey);
    };
    // Re-bind only when a press starts or ends, not on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, browserDrop, folderAudio]);

  const addFolderAsSong = (path: string, name: string) => {
    void folderAudio(path).then((audioPaths) =>
      browserDrop.addFolderAtPlayhead(name, audioPaths),
    );
  };

  const startPress = (event: ReactPointerEvent, item: DragItem) => {
    // Touch has no drag (it fights the list's scrolling): tap and the action
    // bar instead, as in the classic library.
    if (isMobileApp || event.button !== 0) return;
    setDrag({
      item,
      originX: event.clientX,
      originY: event.clientY,
      dragging: false,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const tapFile = (entry: LibraryDirEntry) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  const pressFile = (event: ReactPointerEvent, entry: LibraryDirEntry) => {
    if (isMobileApp) return;
    // Ctrl/Cmd adds to the selection; a plain press on an unselected file
    // selects just it. Dragging a selected file drags the whole selection.
    let nextSelected: ReadonlySet<string> = selected;
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      nextSelected = next;
    } else if (!selected.has(entry.path)) {
      nextSelected = new Set([entry.path]);
    }
    setSelected(nextSelected);
    const paths = nextSelected.has(entry.path) ? [...nextSelected] : [entry.path];
    startPress(event, {
      kind: "files",
      paths,
      label:
        paths.length === 1
          ? entry.name
          : t("library.dragGhostMultiple", { count: paths.length }),
    });
  };

  const renderListing = (path: string, depth: number): ReactNode => {
    const listing: FolderListing | undefined = tree.listings.get(path);
    if (!listing || listing.status === "loading") {
      return (
        <div className="lt-folder-library-note" style={{ paddingLeft: `${depth * 0.9 + 1.6}rem` }}>
          {t("library.folders.loading")}
        </div>
      );
    }
    if (listing.status === "error") {
      return (
        <div
          className="lt-folder-library-note is-error"
          style={{ paddingLeft: `${depth * 0.9 + 1.6}rem` }}
          title={listing.message}
        >
          {t("library.folders.unavailable")}
        </div>
      );
    }
    // Searching filters the files; folders stay so nested matches stay reachable.
    const matches = new Set(filterEntries(listing.entries, query));
    const visible = listing.entries.filter(
      (entry) => entry.kind === "folder" || matches.has(entry),
    );
    if (!visible.length) {
      return (
        <div className="lt-folder-library-note" style={{ paddingLeft: `${depth * 0.9 + 1.6}rem` }}>
          {t(query ? "library.folders.noMatches" : "library.folders.empty")}
        </div>
      );
    }
    return visible.map((entry) => renderEntry(entry, depth));
  };

  const renderEntry = (entry: LibraryDirEntry, depth: number): ReactNode => {
    const indent = { paddingLeft: `${depth * 0.9 + 0.4}rem` };
    if (entry.kind === "folder") {
      const isOpen = tree.expanded.has(entry.path);
      return (
        <div key={entry.path} role="treeitem" aria-expanded={isOpen}>
          <div
            className="lt-folder-library-row is-folder"
            style={indent}
            title={t("library.folders.folderHint")}
            onPointerDown={(event) =>
              startPress(event, { kind: "folder", path: entry.path, name: entry.name })
            }
            onClick={() => {
              if (!dragRef.current?.dragging) tree.toggle(entry.path);
            }}
          >
            <span className="material-symbols-outlined lt-folder-library-chevron" aria-hidden="true">
              {isOpen ? "expand_more" : "chevron_right"}
            </span>
            <span className="material-symbols-outlined" aria-hidden="true">
              {isOpen ? "folder_open" : "folder"}
            </span>
            <span className="lt-folder-library-name">{entry.name}</span>
            {isMobileApp ? addSongButton(entry.path, entry.name) : null}
          </div>
          {isOpen ? <div role="group">{renderListing(entry.path, depth + 1)}</div> : null}
        </div>
      );
    }
    return (
      <div
        key={entry.path}
        role="treeitem"
        aria-selected={selected.has(entry.path)}
        className={`lt-folder-library-row is-file${selected.has(entry.path) ? " is-selected" : ""}`}
        style={{ ...indent, paddingLeft: `${depth * 0.9 + 1.6}rem` }}
        title={entry.name}
        onPointerDown={(event) => pressFile(event, entry)}
        onClick={isMobileApp ? () => tapFile(entry) : undefined}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          {ENTRY_ICONS[entry.kind]}
        </span>
        <span className="lt-folder-library-name">{entry.name}</span>
      </div>
    );
  };

  // Touch only: on desktop a folder is dragged onto the timeline instead.
  const addSongButton = (path: string, name: string) => (
    <button
      type="button"
      className="lt-folder-library-icon is-visible"
      aria-label={t("library.folders.addFolderAsSong", { name })}
      title={t("library.folders.addFolderAsSong", { name })}
      onClick={(event) => {
        event.stopPropagation();
        addFolderAsSong(path, name);
      }}
    >
      <span className="material-symbols-outlined">playlist_add</span>
    </button>
  );

  const ghostPosition = useMemo(() => {
    if (!drag?.dragging) return null;
    return clientToZoomedCoords(drag.x, drag.y);
  }, [drag]);

  return (
    <aside
      className={`lt-folder-library${sessionOpen ? " is-session-open" : ""}`}
      aria-label={t("library.folders.panelAria")}
    >
      <div className="lt-library-panel-header">
        <div>
          <span className="lt-library-panel-eyebrow">{t("library.eyebrow")}</span>
          <h2>{t("library.folders.title")}</h2>
        </div>
        <button
          type="button"
          className="lt-folder-library-add"
          onClick={() => void handleAddPlace()}
        >
          <span className="material-symbols-outlined">create_new_folder</span>
          {t("library.folders.addPlace")}
        </button>
        <input
          type="search"
          // Sin esto el WebView rellenaba el buscador con lo último escrito en
          // otro campo («Song 1») y la lista salía filtrada sin motivo.
          autoComplete="off"
          name="lt-folder-library-search"
          className="lt-folder-library-search"
          placeholder={t("library.folders.search")}
          aria-label={t("library.folders.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="lt-folder-library-places" role="tree" aria-label={t("library.folders.title")}>
        {settings.places.length === 0 ? (
          <div className="lt-folder-library-intro">
            <span className="material-symbols-outlined" aria-hidden="true">
              folder_special
            </span>
            <p>{t("library.folders.intro")}</p>
          </div>
        ) : (
          settings.places.map((place) => {
            const isOpen = tree.expanded.has(place);
            return (
              <div key={place} role="treeitem" aria-expanded={isOpen} className="lt-folder-library-place">
                <div className="lt-folder-library-row is-place" title={place}>
                  <button
                    type="button"
                    className="lt-folder-library-place-toggle"
                    onClick={() => tree.toggle(place)}
                    onPointerDown={(event) =>
                      startPress(event, { kind: "folder", path: place, name: placeLabel(place) })
                    }
                  >
                    <span className="material-symbols-outlined lt-folder-library-chevron" aria-hidden="true">
                      {isOpen ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="material-symbols-outlined" aria-hidden="true">
                      folder_special
                    </span>
                    <span className="lt-folder-library-name">{placeLabel(place)}</span>
                  </button>
                  {isMobileApp ? addSongButton(place, placeLabel(place)) : null}
                  <button
                    type="button"
                    className="lt-folder-library-icon"
                    aria-label={t("library.folders.refresh")}
                    title={t("library.folders.refresh")}
                    onClick={() => void tree.refresh(place)}
                  >
                    <span className="material-symbols-outlined">refresh</span>
                  </button>
                  <button
                    type="button"
                    className="lt-folder-library-icon"
                    aria-label={t("library.folders.removePlace")}
                    title={t("library.folders.removePlace")}
                    onClick={() => void settings.removePlace(place)}
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
                {isOpen ? <div role="group">{renderListing(place, 1)}</div> : null}
              </div>
            );
          })
        )}
      </div>

      {isMobileApp && selected.size > 0 ? (
        <div className="lt-folder-library-actionbar" role="toolbar">
          <button
            type="button"
            className="lt-folder-library-add"
            onClick={() => {
              browserDrop.addPathsAtPlayhead([...selected]);
              setSelected(new Set());
            }}
          >
            <span className="material-symbols-outlined">add_to_queue</span>
            {t("library.folders.addSelection", { count: selected.size })}
          </button>
          <button
            type="button"
            className="lt-folder-library-icon is-visible"
            aria-label={t("library.folders.clearSelection")}
            onClick={() => setSelected(new Set())}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      ) : null}

      <section className={`lt-folder-library-session${sessionOpen ? " is-open" : ""}`}>
        <button
          type="button"
          className="lt-folder-library-session-toggle"
          aria-expanded={sessionOpen}
          onClick={toggleSession}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {sessionOpen ? "expand_more" : "chevron_right"}
          </span>
          {t("library.folders.inThisSession", { count: sessionAssetCount })}
        </button>
        {sessionOpen ? <div className="lt-folder-library-session-body">{sessionPanel}</div> : null}
      </section>

      {drag?.dragging && ghostPosition ? (
        <div
          aria-hidden="true"
          className="lt-library-drag-ghost"
          style={{ left: ghostPosition.x + 16, top: ghostPosition.y + 16 }}
        >
          <span className="lt-library-drag-ghost-badge">
            <span className="material-symbols-outlined">
              {drag.item.kind === "folder" ? "create_new_folder" : "drag_pan"}
            </span>
          </span>
          <span className="lt-library-drag-ghost-copy">
            <strong>{drag.item.kind === "folder" ? drag.item.name : drag.item.label}</strong>
            <span>
              {drag.item.kind === "folder"
                ? t("library.folders.dragHintFolderSong")
                : t("library.dragHintTimeline")}
            </span>
          </span>
        </div>
      ) : null}
    </aside>
  );
}
