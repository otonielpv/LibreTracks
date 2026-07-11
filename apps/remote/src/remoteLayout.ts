/**
 * Remote layout model + persistence. Kept free of React/component imports so it
 * can be unit-tested in isolation; the widget registry that binds these types
 * to actual components lives in App.tsx.
 *
 * A layout is a list of user-named TABS; each tab holds its own list of placed
 * widgets on a fixed-column grid. Each placement gives a widget a column span
 * and an order; rows flow implicitly (dense packing) so we don't store an
 * absolute y. Widgets that must own a full row (timeline, mixer) span all
 * columns. Layouts saved before tabs existed (a flat `widgets` array) are
 * migrated to a single "Principal" tab by normalizeLayout.
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
  | "songHeader"
  | "clipList"
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
  "songHeader",
  "clipList",
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

export type LayoutTab = {
  /** Stable id used for React keys, the active-tab pointer and reorder. */
  id: string;
  /** User-chosen tab name. */
  name: string;
  widgets: WidgetPlacement[];
};

export type RemoteLayout = {
  version: number;
  tabs: LayoutTab[];
  /** Id of the tab shown by default; falls back to the first tab if stale. */
  activeTabId: string;
};

// Bumped to 2 when the model gained tabs. normalizeLayout migrates v1 (a flat
// `widgets` array) into a single tab, so old stored/exported layouts keep working.
export const LAYOUT_VERSION = 2;
const LAYOUT_STORAGE_KEY = "libretracks.remote.layout";

let instanceCounter = 0;
/** Fresh instance id for a placed widget. Not cryptographic — just unique
 * within a session so React keys and edits stay stable. */
export function newWidgetId(type: WidgetType): string {
  instanceCounter += 1;
  return `${type}-${Date.now().toString(36)}-${instanceCounter}`;
}

/** Fresh tab id, unique within a session. */
export function newTabId(): string {
  instanceCounter += 1;
  return `tab-${Date.now().toString(36)}-${instanceCounter}`;
}

function placement(type: WidgetType, w: number, h = 1): WidgetPlacement {
  return { id: newWidgetId(type), type, w, h };
}

/**
 * The default layout reproduces the classic two-view remote: a "Controles" tab
 * (readouts + transport + timeline + control deck + marker grid) and a "Mixer"
 * tab. No live/counter widgets by default — those are opt-in from the palette.
 */
export function defaultLayout(): RemoteLayout {
  const controls: LayoutTab = {
    id: newTabId(),
    name: "Controles",
    widgets: [
      placement("readouts", LAYOUT_COLUMNS, 1),
      placement("transportButtons", LAYOUT_COLUMNS, 1),
      placement("timeline", LAYOUT_COLUMNS, 1),
      placement("controlDeck", LAYOUT_COLUMNS, 1),
      placement("markerGrid", LAYOUT_COLUMNS, 1),
    ],
  };
  const mixer: LayoutTab = {
    id: newTabId(),
    name: "Mixer",
    widgets: [placement("mixer", LAYOUT_COLUMNS, 2)],
  };
  return { version: LAYOUT_VERSION, tabs: [controls, mixer], activeTabId: controls.id };
}

/** A fresh empty tab with the given (or a default) name. */
export function makeEmptyTab(name: string): LayoutTab {
  return { id: newTabId(), name: name.trim() || "Nueva", widgets: [] };
}

function isWidgetType(value: unknown): value is WidgetType {
  return (
    typeof value === "string" && (ALL_WIDGET_TYPES as readonly string[]).includes(value)
  );
}

/** Normalise a raw widgets array: drop unknown types, clamp spans, keep ids. */
function normalizeWidgets(raw: unknown): WidgetPlacement[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const widgets: WidgetPlacement[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Partial<WidgetPlacement>;
    if (!isWidgetType(item.type)) {
      continue;
    }
    widgets.push({
      id: typeof item.id === "string" && item.id ? item.id : newWidgetId(item.type),
      type: item.type,
      w: clampSpan(item.w, LAYOUT_COLUMNS),
      h: clampSpan(item.h, 4),
    });
  }
  return widgets;
}

/**
 * Validate + normalise a parsed layout into the tabbed shape. Handles three
 * inputs: a v2 tabbed layout (validated), a v1 flat `{ widgets }` layout
 * (migrated into one "Principal" tab), and garbage (falls back to default).
 * Unknown widget types are dropped (forward-compat) and spans clamped. A tab
 * with no widgets is kept (users may empty a tab on purpose), but a layout
 * with no valid tabs at all falls back to the default so we never render an
 * empty shell.
 */
export function normalizeLayout(raw: unknown): RemoteLayout {
  if (!raw || typeof raw !== "object") {
    return defaultLayout();
  }
  const candidate = raw as { tabs?: unknown; widgets?: unknown; activeTabId?: unknown };

  // v1 → v2 migration: a flat widgets array becomes a single tab.
  if (!Array.isArray(candidate.tabs) && Array.isArray(candidate.widgets)) {
    const widgets = normalizeWidgets(candidate.widgets);
    if (widgets.length === 0) {
      return defaultLayout();
    }
    const tab: LayoutTab = { id: newTabId(), name: "Principal", widgets };
    return { version: LAYOUT_VERSION, tabs: [tab], activeTabId: tab.id };
  }

  if (!Array.isArray(candidate.tabs)) {
    return defaultLayout();
  }

  const tabs: LayoutTab[] = [];
  for (const entry of candidate.tabs) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Partial<LayoutTab>;
    const id = typeof item.id === "string" && item.id ? item.id : newTabId();
    const name =
      typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Pestaña";
    tabs.push({ id, name, widgets: normalizeWidgets(item.widgets) });
  }

  if (tabs.length === 0) {
    return defaultLayout();
  }

  const activeTabId =
    typeof candidate.activeTabId === "string" &&
    tabs.some((tab) => tab.id === candidate.activeTabId)
      ? candidate.activeTabId
      : tabs[0].id;

  return { version: LAYOUT_VERSION, tabs, activeTabId };
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

// ---------------------------------------------------------------------------
// Export / import: move a layout between devices as a small JSON file. The
// file carries a magic tag so import can reject unrelated JSON, and it reuses
// normalizeLayout so an imported layout from an older/newer build is validated
// the same way stored layouts are.
// ---------------------------------------------------------------------------

const LAYOUT_FILE_KIND = "libretracks.remote.layout";

export type LayoutFile = {
  kind: typeof LAYOUT_FILE_KIND;
  version: number;
  layout: RemoteLayout;
};

/** Serialize a layout to the pretty-printed JSON written to the export file. */
export function serializeLayoutFile(layout: RemoteLayout): string {
  const file: LayoutFile = {
    kind: LAYOUT_FILE_KIND,
    version: LAYOUT_VERSION,
    layout,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse the contents of an imported layout file. Throws with a stable message
 * when the text isn't valid JSON or isn't a LibreTracks layout file, so the
 * caller can show a friendly error. The returned layout is normalised.
 */
export function parseLayoutFile(text: string): RemoteLayout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid-json");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { kind?: unknown }).kind !== LAYOUT_FILE_KIND
  ) {
    throw new Error("not-a-layout-file");
  }
  return normalizeLayout((parsed as { layout?: unknown }).layout);
}

/** A filesystem-friendly, timestamped name for the exported layout file. */
export function layoutExportFilename(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `libretracks-remote-layout-${stamp}.json`;
}
