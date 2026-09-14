/**
 * Client-side filter state for the private product dashboard.
 *
 * Mirrors the dimensions accepted by `functions/api/telemetry/_filters.ts`. The
 * server is the authority: it validates every value and echoes back the ones it
 * kept, so a selection that stops being valid (a version that aged out of the
 * 90-day retention window, say) disappears on the next load instead of pinning
 * the dashboard to an empty result.
 */

export const FILTER_KEYS = [
  "country",
  "version",
  "os",
  "device",
  "hour",
  "weekday",
  "installAge",
  "activeDays",
  "event",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];
export type FilterState = Record<FilterKey, string[]>;

const STORAGE_KEY = "libretracks.analytics.filters";

export function emptyFilters(): FilterState {
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, [] as string[]])) as FilterState;
}

export function isSelected(state: FilterState, key: FilterKey, value: string): boolean {
  return state[key].includes(value);
}

export function activeCount(state: FilterState): number {
  return FILTER_KEYS.reduce((total, key) => total + state[key].length, 0);
}

/**
 * Adds or removes one value. Values inside a dimension are an OR (Spain or
 * Portugal), dimensions are an AND (Spain and Windows), which is the reading
 * that makes a sequence of clicks narrow rather than contradict itself.
 */
export function toggleFilter(state: FilterState, key: FilterKey, value: string): FilterState {
  const next: FilterState = { ...state, [key]: [...state[key]] };
  const at = next[key].indexOf(value);
  if (at === -1) next[key].push(value);
  else next[key].splice(at, 1);
  return next;
}

export function removeFilter(state: FilterState, key: FilterKey, value: string): FilterState {
  return { ...state, [key]: state[key].filter((candidate) => candidate !== value) };
}

export function appendToQuery(state: FilterState, params: URLSearchParams): void {
  for (const key of FILTER_KEYS) {
    if (state[key].length > 0) params.set(`f.${key}`, state[key].join(","));
  }
}

/** Rebuilds the local state from what the server actually accepted. */
export function adoptFilters(echo: unknown): FilterState {
  const source = (echo ?? {}) as Partial<Record<FilterKey, unknown>>;
  const next = emptyFilters();
  for (const key of FILTER_KEYS) {
    const values = source[key];
    if (Array.isArray(values)) {
      next[key] = values.filter((value): value is string => typeof value === "string");
    }
  }
  return next;
}

export function persistFilters(state: FilterState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing denies sessionStorage; filtering still works, it just
    // forgets the selection on reload.
  }
}

export function restoreFilters(): FilterState {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) return adoptFilters(JSON.parse(stored));
  } catch {
    // Unreadable or malformed state falls back to no filters.
  }
  return emptyFilters();
}
