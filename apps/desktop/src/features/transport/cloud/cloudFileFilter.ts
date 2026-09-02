import type { CloudFile } from "../desktopApi";
import { parsePackageFileName, type ParsedPackageName } from "./packageNaming";

/**
 * Searching and filtering the packages stored in the cloud.
 *
 * A band that has been using this for a season has hundreds of songs up there,
 * and "the one in A minor at 72" is how people actually look for one. Kept as
 * pure functions so the rules are testable without a Drive account.
 */

export type CloudFilters = {
  /** Free text, matched against the title. */
  search: string;
  /** Exact key, e.g. `Am`. Empty means any. */
  key: string;
  /** Time signature as written, e.g. `4/4`. Empty means any. */
  timeSignature: string;
  /** Inclusive tempo bounds. `null` means unbounded on that side. */
  bpmMin: number | null;
  bpmMax: number | null;
};

export const NO_FILTERS: CloudFilters = {
  search: "",
  key: "",
  timeSignature: "",
  bpmMin: null,
  bpmMax: null,
};

export type CloudFileWithMeta = CloudFile & { meta: ParsedPackageName };

export function withMeta(files: CloudFile[]): CloudFileWithMeta[] {
  return files.map((file) => ({ ...file, meta: parsePackageFileName(file.name) }));
}

/**
 * Fold accents and case so a search for `cancion` finds `Canción`.
 *
 * Typing accents is a nuisance on a phone and on a stage laptop, and the whole
 * point of the search is to find something in a hurry.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function matchesFilters(
  file: CloudFileWithMeta,
  filters: CloudFilters,
): boolean {
  if (filters.search.trim()) {
    // Matched against the whole name rather than the parsed title, so typing
    // "72bpm" or "Am" in the search box also works.
    if (!fold(file.name).includes(fold(filters.search.trim()))) {
      return false;
    }
  }
  if (filters.key && file.meta.key !== filters.key) {
    return false;
  }
  if (filters.timeSignature && file.meta.timeSignature !== filters.timeSignature) {
    return false;
  }
  if (filters.bpmMin !== null || filters.bpmMax !== null) {
    // A package with no tempo in its name is excluded once a tempo range is
    // asked for: it cannot be shown to satisfy the question, and quietly
    // including it would make the filter untrustworthy.
    if (typeof file.meta.bpm !== "number") {
      return false;
    }
    if (filters.bpmMin !== null && file.meta.bpm < filters.bpmMin) return false;
    if (filters.bpmMax !== null && file.meta.bpm > filters.bpmMax) return false;
  }
  return true;
}

export function filterCloudFiles(
  files: CloudFile[],
  filters: CloudFilters,
): CloudFileWithMeta[] {
  return withMeta(files).filter((file) => matchesFilters(file, filters));
}

/** Keys present in this listing, sorted, for the filter dropdown. */
export function availableKeys(files: CloudFileWithMeta[]): string[] {
  const keys = new Set<string>();
  for (const file of files) {
    if (file.meta.key) keys.add(file.meta.key);
  }
  return [...keys].sort();
}

/** Time signatures present in this listing, sorted, for the filter dropdown. */
export function availableTimeSignatures(files: CloudFileWithMeta[]): string[] {
  const meters = new Set<string>();
  for (const file of files) {
    if (file.meta.timeSignature) meters.add(file.meta.timeSignature);
  }
  return [...meters].sort();
}

export function hasActiveFilters(filters: CloudFilters): boolean {
  return (
    filters.search.trim() !== "" ||
    filters.key !== "" ||
    filters.timeSignature !== "" ||
    filters.bpmMin !== null ||
    filters.bpmMax !== null
  );
}
