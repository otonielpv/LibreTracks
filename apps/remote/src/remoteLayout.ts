/**
 * Remote layout model + persistence. Kept free of React/component imports so it
 * can be unit-tested in isolation; the widget registry that binds these types
 * to actual components lives in App.tsx.
 *
 * A layout is a list of placed widgets on a fixed-column grid. Each placement
 * gives a widget a column span and an order; rows flow implicitly (dense
 * packing) so we don't have to store absolute y for every item. Widgets that
 * must own a full row (timeline, mixer) simply span all columns.
 */

/** Every widget type the remote can place. Adding one here + in the registry
 * (App.tsx) makes it available to the layout and the editor palette. */
export type WidgetType =
  | "readouts"
  | "transportButtons"
  | "timeline"
  | "controlDeck"
  | "markerGrid"
  | "mixer"
  | "nextMarker"
  | "nextSong"
  | "currentKey"
  | "progressMarker"
  | "progressSong"
  | "countdownMarkerBars"
  | "countdownSongTime";

export const ALL_WIDGET_TYPES: readonly WidgetType[] = [
  "readouts",
  "transportButtons",
  "timeline",
  "controlDeck",
  "markerGrid",
  "mixer",
  "nextMarker",
  "nextSong",
  "currentKey",
  "progressMarker",
  "progressSong",
  "countdownMarkerBars",
  "countdownSongTime",
];

/** The layout grid is this many columns wide; widget widths are 1..COLUMNS. */
export const LAYOUT_COLUMNS = 6;

export type WidgetPlacement = {
  /** Stable instance id (a type may appear more than once). */
  id: string;
  type: WidgetType;
  /** Column span in [1, LAYOUT_COLUMNS]. */
  w: number;
  /** Row span (most widgets are 1; timeline/mixer can be taller). */
  h: number;
};

export type RemoteLayout = {
  version: number;
  widgets: WidgetPlacement[];
};

export const LAYOUT_VERSION = 1;
const LAYOUT_STORAGE_KEY = "libretracks.remote.layout";

let instanceCounter = 0;
/** Fresh instance id for a placed widget. Not cryptographic — just unique
 * within a session so React keys and edits stay stable. */
export function newWidgetId(type: WidgetType): string {
  instanceCounter += 1;
  return `${type}-${Date.now().toString(36)}-${instanceCounter}`;
}

function placement(type: WidgetType, w: number, h = 1): WidgetPlacement {
  return { id: newWidgetId(type), type, w, h };
}

/**
 * The default layout reproduces the pre-editor fixed stack: the live-widgets
 * row, the timeline, the control deck, the marker grid, and the mixer — so a
 * user who never opens the editor sees exactly what they saw before.
 */
export function defaultLayout(): RemoteLayout {
  return {
    version: LAYOUT_VERSION,
    widgets: [
      placement("countdownMarkerBars", 1),
      placement("nextMarker", 1),
      placement("progressMarker", 1),
      placement("currentKey", 1),
      placement("nextSong", 1),
      placement("progressSong", 1),
      placement("timeline", LAYOUT_COLUMNS, 1),
      placement("controlDeck", LAYOUT_COLUMNS, 1),
      placement("markerGrid", LAYOUT_COLUMNS, 1),
      placement("mixer", LAYOUT_COLUMNS, 2),
    ],
  };
}

function isWidgetType(value: unknown): value is WidgetType {
  return (
    typeof value === "string" && (ALL_WIDGET_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Validate + normalise a parsed layout. Unknown widget types are dropped
 * (forward-compat with layouts from newer builds), spans are clamped, and a
 * missing/empty result falls back to the default so the remote never renders
 * an empty canvas.
 */
export function normalizeLayout(raw: unknown): RemoteLayout {
  if (!raw || typeof raw !== "object") {
    return defaultLayout();
  }
  const candidate = raw as Partial<RemoteLayout>;
  if (!Array.isArray(candidate.widgets)) {
    return defaultLayout();
  }

  const widgets: WidgetPlacement[] = [];
  for (const entry of candidate.widgets) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Partial<WidgetPlacement>;
    if (!isWidgetType(item.type)) {
      continue;
    }
    const w = clampSpan(item.w, LAYOUT_COLUMNS);
    const h = clampSpan(item.h, 4);
    widgets.push({
      id: typeof item.id === "string" && item.id ? item.id : newWidgetId(item.type),
      type: item.type,
      w,
      h,
    });
  }

  if (widgets.length === 0) {
    return defaultLayout();
  }
  return { version: LAYOUT_VERSION, widgets };
}

function clampSpan(value: unknown, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 1;
  return Math.max(1, Math.min(max, n));
}

export function readStoredLayout(): RemoteLayout {
  if (typeof window === "undefined") {
    return defaultLayout();
  }
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return defaultLayout();
    }
    return normalizeLayout(JSON.parse(raw));
  } catch {
    return defaultLayout();
  }
}

export function writeStoredLayout(layout: RemoteLayout): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage blocked (private mode / quota) — keep the in-memory layout only.
  }
}

export function clearStoredLayout(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
  } catch {
    // Ignore — nothing else to do.
  }
}
