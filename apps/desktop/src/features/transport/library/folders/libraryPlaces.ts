import type { LibraryDirEntry } from "../../desktopApi";
import { libraryAssetFileName } from "../../helpers";

/** Paths compare without case or trailing separators: "D:\\Stems\\" and
 * "d:/stems" are the same folder on Windows and macOS, the platforms that
 * matter here. */
function placeKey(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

/** Add a place unless it is already there. Returns the same array when nothing
 * changes, so callers can skip the save. */
export function addPlace(places: string[], path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) return places;
  const key = placeKey(trimmed);
  return places.some((place) => placeKey(place) === key) ? places : [...places, trimmed];
}

export function removePlace(places: string[], path: string): string[] {
  const key = placeKey(path);
  const next = places.filter((place) => placeKey(place) !== key);
  return next.length === places.length ? places : next;
}

/** What a place is called in the list: its folder name ("Stems"), or the
 * whole path for a drive root ("D:\\"). An Android tree URI is decoded the
 * same way track names are. */
export function placeLabel(path: string): string {
  if (/^content:\/\//i.test(path)) return libraryAssetFileName(path);
  const trimmed = path.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).at(-1);
  return name && !/^[A-Za-z]:$/.test(name) ? name : path;
}

/** Entries whose name contains the query, ignoring case and accents, so
 * "bateria" finds "Batería". An empty query keeps everything. */
export function filterEntries(entries: LibraryDirEntry[], query: string): LibraryDirEntry[] {
  const needle = normalizeForSearch(query.trim());
  if (!needle) return entries;
  return entries.filter((entry) => normalizeForSearch(entry.name).includes(needle));
}

function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** The files of a listing that can go straight onto the timeline as audio. */
export function audioPathsOf(entries: LibraryDirEntry[]): string[] {
  return entries.filter((entry) => entry.kind === "audio").map((entry) => entry.path);
}
