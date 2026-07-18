/**
 * MRU list of recently opened sessions, persisted in localStorage (same
 * pattern as the timeline recent-colors list). Entries are recorded whenever a
 * session is opened/created/imported and surfaced in two places: the
 * empty-state landing (first LANDING_RECENT_SESSIONS_LIMIT entries) and the
 * FILE > "Abrir reciente" submenu (the whole stored list, Reaper-style).
 *
 * Entries are NOT removed when the target file disappears — a session on an
 * unplugged external drive should survive in the list; opening it simply
 * surfaces the backend error.
 */

export type RecentSessionEntry = {
  /** Absolute path to the `.ltsession` file. */
  path: string;
  /** Display name derived from the session file/folder name. */
  name: string;
  /** Unix ms of the last time this session was opened or created. */
  openedAtMs: number;
};

const STORAGE_KEY = "libretracks.recentSessions";
/** Ceiling of the persisted list (what the FILE menu shows). */
const STORED_RECENT_SESSIONS_LIMIT = 30;
/** How many entries the landing column shows (scrollable). */
export const LANDING_RECENT_SESSIONS_LIMIT = 10;

/** File stems that carry no session identity; fall back to the folder name. */
const GENERIC_SESSION_STEMS = new Set(["session", "import-session"]);

/**
 * Derive the user-facing name from the `.ltsession` path. Sessions are folders
 * holding `<name>.ltsession`, so the file stem is normally the session name;
 * for generic stems (e.g. an imported `import-session.ltsession`) the parent
 * folder carries the real name instead.
 */
function deriveSessionName(sessionFilePath: string): string {
  const segments = sessionFilePath.split(/[\\/]/).filter(Boolean);
  const fileName = segments[segments.length - 1] ?? sessionFilePath;
  const stem = fileName.replace(/\.ltsession$/i, "");
  if (!GENERIC_SESSION_STEMS.has(stem.toLowerCase())) {
    return stem;
  }
  return segments[segments.length - 2] ?? stem;
}

/** Read the persisted recents list, tolerating malformed storage. */
export function loadRecentSessions(): RecentSessionEntry[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry): entry is RecentSessionEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as RecentSessionEntry).path === "string" &&
          (entry as RecentSessionEntry).path.length > 0,
      )
      .map((entry) => ({
        path: entry.path,
        name:
          typeof entry.name === "string" && entry.name.length > 0
            ? entry.name
            : deriveSessionName(entry.path),
        openedAtMs:
          typeof entry.openedAtMs === "number" ? entry.openedAtMs : 0,
      }))
      .slice(0, STORED_RECENT_SESSIONS_LIMIT);
  } catch {
    return [];
  }
}

function persist(entries: RecentSessionEntry[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full/blocked — recents are a convenience, drop persistence.
  }
}

/**
 * Record a session open/create: push to the front, dedup by path
 * (case-insensitively — Windows/macOS filesystems are case-insensitive).
 */
export function pushRecentSession(sessionFilePath: string) {
  if (!sessionFilePath) {
    return;
  }
  const normalized = sessionFilePath.toLowerCase();
  const next: RecentSessionEntry[] = [
    {
      path: sessionFilePath,
      name: deriveSessionName(sessionFilePath),
      openedAtMs: Date.now(),
    },
    ...loadRecentSessions().filter(
      (entry) => entry.path.toLowerCase() !== normalized,
    ),
  ].slice(0, STORED_RECENT_SESSIONS_LIMIT);
  persist(next);
}

export function clearRecentSessions() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort.
  }
}
