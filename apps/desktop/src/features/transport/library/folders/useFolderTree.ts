import { useCallback, useRef, useState } from "react";

import { listLibraryDir, type LibraryDirEntry } from "../../desktopApi";

export type FolderListing =
  | { status: "loading" }
  | { status: "ready"; entries: LibraryDirEntry[] }
  | { status: "error"; message: string };

/**
 * Expanded folders of the folder library and their listings. A folder is read
 * from disk only when expanded, one level at a time (see list_library_dir), so
 * opening a place with thousands of nested files costs one directory read.
 * Collapsing keeps the listing cached; `refresh` re-reads it.
 */
export function useFolderTree() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [listings, setListings] = useState<ReadonlyMap<string, FolderListing>>(
    () => new Map(),
  );
  // Latest request per folder: a slow read that loses to a refresh is dropped.
  const requestIds = useRef(new Map<string, number>());

  const load = useCallback(async (path: string) => {
    const requestId = (requestIds.current.get(path) ?? 0) + 1;
    requestIds.current.set(path, requestId);
    setListings((current) => new Map(current).set(path, { status: "loading" }));
    let listing: FolderListing;
    try {
      listing = { status: "ready", entries: await listLibraryDir(path) };
    } catch (error) {
      listing = { status: "error", message: String(error) };
    }
    if (requestIds.current.get(path) !== requestId) return;
    setListings((current) => new Map(current).set(path, listing));
  }, []);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      if (!listings.has(path) && !expanded.has(path)) {
        void load(path);
      }
    },
    [expanded, listings, load],
  );

  return {
    expanded,
    listings,
    toggle,
    refresh: load,
  };
}
