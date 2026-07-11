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
  | "readoutTime"
  | "readoutBar"
  | "readoutBpm"
  | "readoutSignature"
  | "readoutSong"
  | "transportButtons"
  | "playButton"
  | "pauseButton"
  | "stopButton"
  | "clickButton"
  | "guideButton"
  | "timeline"
  | "controlDeck"
  | "deckVamp"
  | "deckJump"
  | "deckSong"
  | "deckRegion"
  | "markerGrid"
  | "mixer"
  | "mixerSongFilter"
  | "mixerSongMaster"
  | "mixerFaders"
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
  "readoutTime",
  "readoutBar",
  "readoutBpm",
  "readoutSignature",
  "readoutSong",
  "transportButtons",
  "playButton",
  "pauseButton",
  "stopButton",
  "clickButton",
  "guideButton",
  "timeline",
  "controlDeck",
  "deckVamp",
  "deckJump",
  "deckSong",
  "deckRegion",
  "markerGrid",
  "mixer",
  "mixerSongFilter",
  "mixerSongMaster",
  "mixerFaders",
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
/** A fine grid keeps placement predictable while allowing near pixel-level
 * control on phones. v3 used six columns; v4 multiplies old coordinates by
 * four so existing layouts keep exactly the same visual proportions. */
export const LAYOUT_COLUMNS = 24;
/** Max rows a widget may span, and the tallest y a widget may start at. The
 * grid grows to fit, but we clamp starts/spans to keep numbers sane. */
export const LAYOUT_MAX_ROWS = 60;

export type WidgetPlacement = {
  /** Stable instance id (a type may appear more than once). */
  id: string;
  type: WidgetType;
  /** Zero-based start column in [0, LAYOUT_COLUMNS-1]. Absolute (Mixing-Station
   * style): the widget lives exactly here, overlaps allowed. */
  x: number;
  /** Zero-based start row in [0, LAYOUT_MAX_ROWS-1]. */
  y: number;
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

// v2 gained tabs; v3 gained absolute x/y positions per widget (Mixing-Station
// grid). normalizeLayout migrates v1 (flat array) and v2/v3 widgets that lack
// x/y by auto-placing them, so old stored/exported layouts keep working.
export const LAYOUT_VERSION = 4;
const LEGACY_GRID_SCALE = 4;
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

function placement(
  type: WidgetType,
  x: number,
  y: number,
  w: number,
  h = 1,
): WidgetPlacement {
  return { id: newWidgetId(type), type, x, y, w, h };
}

/**
 * The default layout reproduces the classic two-view remote: a "Controles" tab
 * (readouts + transport + timeline + control deck + marker grid, stacked in
 * rows) and a "Mixer" tab. No live/counter widgets by default — opt-in from the
 * palette.
 */
export function defaultLayout(): RemoteLayout {
  const controls: LayoutTab = {
    id: newTabId(),
    name: "Controles",
    widgets: [
      placement("readouts", 0, 0, LAYOUT_COLUMNS, 4),
      placement("transportButtons", 0, 4, LAYOUT_COLUMNS, 5),
      placement("timeline", 0, 9, LAYOUT_COLUMNS, 7),
      placement("controlDeck", 0, 16, LAYOUT_COLUMNS, 9),
      placement("markerGrid", 0, 25, LAYOUT_COLUMNS, 12),
    ],
  };
  const mixer: LayoutTab = {
    id: newTabId(),
    name: "Mixer",
    widgets: [placement("mixer", 0, 0, LAYOUT_COLUMNS, 28)],
  };
  return { version: LAYOUT_VERSION, tabs: [controls, mixer], activeTabId: controls.id };
}

/**
 * Assign x/y to widgets that lack them (migration from the pre-X/Y flow-packed
 * model). Walks a LAYOUT_COLUMNS-wide grid left→right, top→bottom, honouring
 * each widget's width and wrapping to the next row when it doesn't fit —
 * reproducing the old dense-flow order as absolute coordinates. Widgets that
 * already have valid x/y are left untouched.
 */
function autoPlace(widgets: WidgetPlacement[]): WidgetPlacement[] {
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 1;
  return widgets.map((widget) => {
    if (
      Number.isFinite((widget as { x?: number }).x) &&
      Number.isFinite((widget as { y?: number }).y)
    ) {
      return widget;
    }
    const w = Math.min(LAYOUT_COLUMNS, Math.max(1, widget.w));
    if (cursorX + w > LAYOUT_COLUMNS) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 1;
    }
    const placed = { ...widget, x: cursorX, y: cursorY };
    cursorX += w;
    rowHeight = Math.max(rowHeight, widget.h);
    if (cursorX >= LAYOUT_COLUMNS) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 1;
    }
    return placed;
  });
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

/**
 * Normalise a raw widgets array: drop unknown types, clamp spans and (when
 * present) x/y, keep ids. Widgets missing valid x/y keep them undefined here;
 * the caller runs autoPlace to assign coordinates, so a mix of positioned and
 * legacy widgets all end up placed.
 */
function normalizeWidgets(raw: unknown, legacyGrid = false): WidgetPlacement[] {
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
    const scale = legacyGrid ? LEGACY_GRID_SCALE : 1;
    const w = clampSpan(
      typeof item.w === "number" ? item.w * scale : item.w,
      LAYOUT_COLUMNS,
    );
    const h = clampSpan(typeof item.h === "number" ? item.h * scale : item.h, LAYOUT_MAX_ROWS);
    // x/y only kept when both are finite; otherwise left off so autoPlace fills
    // them (migration from the pre-X/Y model).
    const hasPos =
      typeof item.x === "number" &&
      Number.isFinite(item.x) &&
      typeof item.y === "number" &&
      Number.isFinite(item.y);
    widgets.push({
      id: typeof item.id === "string" && item.id ? item.id : newWidgetId(item.type),
      type: item.type,
      x: hasPos ? Math.max(0, Math.min(LAYOUT_COLUMNS - 1, Math.round((item.x as number) * scale))) : (undefined as unknown as number),
      y: hasPos ? Math.max(0, Math.min(LAYOUT_MAX_ROWS - 1, Math.round((item.y as number) * scale))) : (undefined as unknown as number),
      w,
      h,
    });
  }
  return autoPlace(widgets);
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
  const candidate = raw as { version?: unknown; tabs?: unknown; widgets?: unknown; activeTabId?: unknown };
  const legacyGrid = typeof candidate.version !== "number" || candidate.version < 4;

  // v1 → v2 migration: a flat widgets array becomes a single tab.
  if (!Array.isArray(candidate.tabs) && Array.isArray(candidate.widgets)) {
    const widgets = normalizeWidgets(candidate.widgets, legacyGrid);
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
    tabs.push({ id, name, widgets: normalizeWidgets(item.widgets, legacyGrid) });
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
