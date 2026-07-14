import type { TrackSummary } from "@libretracks/shared/models";

export const TIMELINE_COLOR_PRESETS = [
  { label: "Rojo", value: "#E35D5B" },
  { label: "Coral", value: "#F08A6C" },
  { label: "Naranja", value: "#EE8A3C" },
  { label: "Ambar", value: "#E0A83A" },
  { label: "Lima", value: "#B7D34A" },
  { label: "Verde", value: "#57B66C" },
  { label: "Esmeralda", value: "#2FA98A" },
  { label: "Cian", value: "#3CDDC7" },
  { label: "Celeste", value: "#4FB8E6" },
  { label: "Azul", value: "#5C8CE6" },
  { label: "Indigo", value: "#6F6FE0" },
  { label: "Violeta", value: "#9C73E6" },
  { label: "Magenta", value: "#C96FD6" },
  { label: "Rosa", value: "#DF6FA8" },
] as const;

const RECENT_COLORS_STORAGE_KEY = "libretracks.recentColors";
const RECENT_COLORS_LIMIT = 8;

/** Read the persisted recent-colors list, tolerating malformed storage. */
export function loadRecentColors(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(RECENT_COLORS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const seen = new Set<string>();
    const colors: string[] = [];
    for (const entry of parsed) {
      const normalized =
        typeof entry === "string" ? normalizeTimelineColorInput(entry) : null;
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        colors.push(normalized);
      }
    }
    return colors.slice(0, RECENT_COLORS_LIMIT);
  } catch {
    return [];
  }
}

/** Push a color to the front (MRU), dedup case-insensitively, persist. */
export function pushRecentColor(previous: string[], color: string): string[] {
  const normalized = normalizeTimelineColorInput(color);
  if (!normalized) {
    return previous;
  }
  const next = [
    normalized,
    ...previous.filter((entry) => entry !== normalized),
  ].slice(0, RECENT_COLORS_LIMIT);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        RECENT_COLORS_STORAGE_KEY,
        JSON.stringify(next),
      );
    } catch {
      // Storage full/blocked — keep the in-memory list, drop persistence.
    }
  }
  return next;
}

export function normalizeTimelineColorInput(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

export function resolveSharedTimelineColor(tracks: TrackSummary[]) {
  if (tracks.length === 0) {
    return null;
  }

  const [firstTrack, ...remainingTracks] = tracks;
  const firstColor = normalizeTimelineColorInput(firstTrack.color);
  return remainingTracks.every(
    (track) => normalizeTimelineColorInput(track.color) === firstColor,
  )
    ? firstColor
    : null;
}
