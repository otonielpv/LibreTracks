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
  | "readoutSession"
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
  | "jumpToSongButton"
  | "markerGrid"
  | "mixer"
  | "mixerSongFilter"
  | "mixerSongMaster"
  | "mixerFaders"
  | "songHeader"
  | "clipList"
  | "pads"
  | "metronomeSettings"
  | "voiceGuideSettings"
  | "layoutTitle"
  | "layoutNote"
  | "layoutGroup"
  | "spacer"
  | "separator"
  | "performanceSettings"
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
  "readoutSession",
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
  "jumpToSongButton",
  "markerGrid",
  "mixer",
  "mixerSongFilter",
  "mixerSongMaster",
  "mixerFaders",
  "songHeader",
  "clipList",
  "pads",
  "metronomeSettings",
  "voiceGuideSettings",
  "layoutTitle",
  "layoutNote",
  "layoutGroup",
  "spacer",
  "separator",
  "performanceSettings",
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
/** Enough room for every metronome field at the default interface scale
 * without forcing the tool widget to start with its own scrollbar. */
export const DEFAULT_METRONOME_WIDGET_HEIGHT = 26;
/** Same idea for the pads widget: pack, routing, key grid, volume, both fades
 * and the "stop with playback" switch without an inner scrollbar. Bumping this
 * re-generates the Tools preset for users who never customised their layout
 * (see the hasToolsPreset check in App.tsx). */
export const DEFAULT_PADS_WIDGET_HEIGHT = 32;

export type WidgetTextAlign = "left" | "center" | "right";
export type SeparatorStyle = "line" | "dashed" | "space";

/** Optional, type-specific presentation settings stored with one widget
 * instance. Keeping this deliberately small makes exported layouts portable. */
export type WidgetConfig = {
  text?: string;
  align?: WidgetTextAlign;
  separatorStyle?: SeparatorStyle;
};

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
  /** Presentation settings for configurable design widgets. */
  config?: WidgetConfig;
  /** Id of a layoutGroup that moves this widget as one of its contents. */
  groupId?: string;
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
  /** Set after the user changes widget geometry/content. Mobile then respects
   * the exact grid instead of applying the untouched classic preset flow. */
  customized?: boolean;
  /** Device family used to create an untouched preset. */
  presetProfile?: LayoutPresetProfile;
  /** Editor-only preference: how drops resolve overlaps. Defaults to "free". */
  placementMode?: LayoutPlacementMode;
  /** Tab strip height in rem, in [TAB_HEIGHT_MIN_REM, TAB_HEIGHT_MAX_REM]. */
  tabHeightRem?: number;
};

export type LayoutPresetProfile = "standard" | "tablet" | "phone";

/** How a drop resolves an overlap with the widgets already placed.
 * "free" keeps the Mixing-Station behaviour (overlaps allowed, nothing moves);
 * "push" shifts whatever the dropped widget lands on straight down, cascading
 * to the widgets below it. */
export type LayoutPlacementMode = "free" | "push";

/** Height of the tab strip ("Controles", "Mixer", …) in rem. The tabs are the
 * one piece of chrome the widget grid can't resize, and the default is a small
 * target on a tablet. Persisted with the layout so it survives a reload. */
export const TAB_HEIGHT_MIN_REM = 1.6;
export const TAB_HEIGHT_MAX_REM = 5;
export const DEFAULT_TAB_HEIGHT_REM = 1.9;

export function clampTabHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TAB_HEIGHT_REM;
  // Quantised to 0.1rem so the stepper produces stable, comparable numbers.
  const snapped = Math.round(value * 10) / 10;
  return Math.max(TAB_HEIGHT_MIN_REM, Math.min(TAB_HEIGHT_MAX_REM, snapped));
}

// v2 gained tabs; v3 gained absolute x/y positions; v4 moved to the 24-column
// grid; v5 adds configurable design widgets and persisted widget groups; v6
// adds the placement mode and the tab strip height (both optional, so a v5
// layout loads unchanged with the previous defaults).
// normalizeLayout keeps every older shape compatible.
export const LAYOUT_VERSION = 6;
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
 * (readouts + transport + timeline + control deck + jump-to-song + marker grid,
 * stacked in rows) and a "Mixer" tab. No live/counter widgets by default —
 * opt-in from the palette.
 *
 * "Saltar a canción" is its own widget rather than a button inside the region
 * deck. On a roomy screen (standard/tablet) it sits on the SAME row as the
 * song selector, to the right of the deck, which is where it used to live and
 * where the hand expects it; the deck gives up those columns. A phone has no
 * width to share, so there it takes a full-width row of its own and everything
 * below shifts down.
 */
export function defaultLayout(profile: LayoutPresetProfile = "standard"): RemoteLayout {
  const phone = profile === "phone";
  const tablet = profile === "tablet";
  const deckY = phone ? 13 : tablet ? 10 : 16;
  const deckH = phone ? 8 : tablet ? 7 : 9;
  /** Columns reserved for the jump button beside the deck (0 = its own row). */
  const jumpW = phone ? LAYOUT_COLUMNS : 5;
  const jumpH = phone ? 4 : deckH;
  // Beside the deck it shares the deck's row; on a phone it opens a new one.
  const jumpX = phone ? 0 : LAYOUT_COLUMNS - jumpW;
  const jumpY = phone ? deckY + deckH : deckY;
  const belowY = phone ? deckY + deckH + jumpH : deckY + deckH;
  const controls: LayoutTab = {
    id: newTabId(),
    name: "Controles",
    widgets: [
      placement("readouts", 0, 0, LAYOUT_COLUMNS, phone ? 6 : tablet ? 3 : 4),
      placement("transportButtons", 0, phone ? 6 : tablet ? 3 : 4, LAYOUT_COLUMNS, phone ? 3 : tablet ? 3 : 5),
      placement("timeline", 0, phone ? 9 : tablet ? 6 : 9, LAYOUT_COLUMNS, phone ? 4 : tablet ? 4 : 7),
      placement("controlDeck", 0, deckY, phone ? LAYOUT_COLUMNS : LAYOUT_COLUMNS - jumpW, deckH),
      placement("jumpToSongButton", jumpX, jumpY, jumpW, jumpH),
      placement("markerGrid", 0, belowY, LAYOUT_COLUMNS, phone ? 10 : tablet ? 10 : 12),
    ],
  };
  const mixer: LayoutTab = {
    id: newTabId(),
    name: "Mixer",
    widgets: [placement("mixer", 0, 0, LAYOUT_COLUMNS, 28)],
  };
  const tools: LayoutTab = {
    id: newTabId(),
    name: "Herramientas",
    widgets: phone
      ? [
          placement("metronomeSettings", 0, 0, LAYOUT_COLUMNS, DEFAULT_METRONOME_WIDGET_HEIGHT),
          placement("voiceGuideSettings", 0, DEFAULT_METRONOME_WIDGET_HEIGHT, LAYOUT_COLUMNS, 14),
          placement("pads", 0, DEFAULT_METRONOME_WIDGET_HEIGHT + 14, LAYOUT_COLUMNS, DEFAULT_PADS_WIDGET_HEIGHT),
        ]
      : [
          placement("metronomeSettings", 0, 0, 8, DEFAULT_METRONOME_WIDGET_HEIGHT),
          placement("voiceGuideSettings", 8, 0, 8, 20),
          placement("pads", 16, 0, 8, DEFAULT_PADS_WIDGET_HEIGHT),
        ],
  };
  return {
    version: LAYOUT_VERSION,
    tabs: [controls, mixer, tools],
    activeTabId: controls.id,
    presetProfile: profile,
    placementMode: "free",
    tabHeightRem: DEFAULT_TAB_HEIGHT_REM,
  };
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

function normalizeWidgetConfig(type: WidgetType, raw: unknown): WidgetConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const config: WidgetConfig = {};

  if (type === "layoutTitle" || type === "layoutNote" || type === "layoutGroup") {
    if (typeof input.text === "string") {
      config.text = input.text.slice(0, type === "layoutNote" ? 1000 : 120);
    }
    if (input.align === "left" || input.align === "center" || input.align === "right") {
      config.align = input.align;
    }
  }
  if (
    type === "separator" &&
    (input.separatorStyle === "line" || input.separatorStyle === "dashed" || input.separatorStyle === "space")
  ) {
    config.separatorStyle = input.separatorStyle;
  }

  return Object.keys(config).length > 0 ? config : undefined;
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
    const config = normalizeWidgetConfig(item.type, item.config);
    widgets.push({
      id: typeof item.id === "string" && item.id ? item.id : newWidgetId(item.type),
      type: item.type,
      x: hasPos ? Math.max(0, Math.min(LAYOUT_COLUMNS - 1, Math.round((item.x as number) * scale))) : (undefined as unknown as number),
      y: hasPos ? Math.max(0, Math.min(LAYOUT_MAX_ROWS - 1, Math.round((item.y as number) * scale))) : (undefined as unknown as number),
      w,
      h,
      ...(config ? { config } : {}),
      ...(typeof item.groupId === "string" && item.groupId ? { groupId: item.groupId } : {}),
    });
  }
  const placed = autoPlace(widgets);
  const validGroupIds = new Set(
    placed.filter((widget) => widget.type === "layoutGroup").map((widget) => widget.id),
  );
  return placed.map((widget) => {
    if (
      widget.type !== "layoutGroup" &&
      widget.groupId &&
      validGroupIds.has(widget.groupId)
    ) {
      return widget;
    }
    if (!widget.groupId) return widget;
    const { groupId: _groupId, ...withoutGroup } = widget;
    return withoutGroup;
  });
}

const GROUP_HEADER_ROWS = 2;

function isInsideGroup(widget: WidgetPlacement, group: WidgetPlacement): boolean {
  return (
    group.type === "layoutGroup" &&
    widget.type !== "layoutGroup" &&
    widget.x >= group.x &&
    widget.y >= group.y + GROUP_HEADER_ROWS &&
    widget.x + widget.w <= group.x + group.w &&
    widget.y + widget.h <= group.y + group.h
  );
}

/** Smallest group whose content area fully contains the widget. The first two
 * rows are reserved for the group title, matching the visible editor frame. */
export function containingGroupId(
  widgets: WidgetPlacement[],
  widget: WidgetPlacement,
): string | null {
  return widgets
    .filter((candidate) => isInsideGroup(widget, candidate))
    .sort((a, b) => a.w * a.h - b.w * b.h)[0]?.id ?? null;
}

/** Move a placement. Moving a group applies the same delta to all its direct
 * contents, preserving their relative geometry. */
export function moveWidgetWithGroup(
  widgets: WidgetPlacement[],
  id: string,
  x: number,
  y: number,
): WidgetPlacement[] {
  const target = widgets.find((widget) => widget.id === id);
  if (!target) return widgets;
  const dx = x - target.x;
  const dy = y - target.y;
  return widgets.map((widget) => {
    if (widget.id === id) return { ...widget, x, y };
    if (target.type === "layoutGroup" && widget.groupId === target.id) {
      return { ...widget, x: widget.x + dx, y: widget.y + dy };
    }
    return widget;
  });
}

/** Is a client point inside a client rect (inclusive)? Used for the editor's
 * trash zone, which is hit-tested against its live rect rather than by event
 * target, because a drag holds pointer capture on the canvas. A zero-width rect
 * means "not laid out yet" and never matches. */
export function rectContainsPoint(
  rect: { left: number; right: number; top: number; bottom: number; width: number } | null | undefined,
  x: number,
  y: number,
): boolean {
  if (!rect || rect.width === 0) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function overlaps(a: WidgetPlacement, b: WidgetPlacement): boolean {
  return (
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

/**
 * Resolve overlaps by pushing widgets straight down ("push" placement mode).
 * The widget identified by `id` is the anchor: it stays exactly where the user
 * dropped it, and every widget it overlaps moves down just enough to clear it —
 * cascading, so a widget displaced by the first pass in turn pushes whatever
 * sits below it. Only y changes; columns are never reflowed, which keeps the
 * result predictable when dragging with a finger.
 *
 * A layoutGroup pushes as one body: its contents move with it and the group's
 * own children are never pushed by their group.
 */
export function pushWidgetsDown(
  widgets: WidgetPlacement[],
  id: string,
): WidgetPlacement[] {
  const anchor = widgets.find((widget) => widget.id === id);
  if (!anchor) return widgets;

  // Widgets moved as a unit with a placement: a group carries its contents.
  const bodyOf = (widget: WidgetPlacement): string[] =>
    widget.type === "layoutGroup"
      ? [widget.id, ...widgets.filter((w) => w.groupId === widget.id).map((w) => w.id)]
      : [widget.id];

  const result = new Map(widgets.map((widget) => [widget.id, { ...widget }]));
  // Settled bodies are final. The anchor is settled first (it stays where the
  // user put it); every other body settles in top-down order, so a widget is
  // only placed once everything that could push it is already fixed. Settling
  // in queue order instead would let a lower widget freeze before the widget
  // above it had been pushed onto it.
  const settled = new Set(bodyOf(anchor));

  // Heads still to place: one entry per body (a group's children ride along).
  const pending = widgets
    .filter((widget) => !settled.has(widget.id))
    .filter((widget) => !(widget.groupId && settled.has(widget.groupId)));

  // Process in the ORIGINAL top-down order. The order must be fixed up front,
  // not re-read from `result` each round: `result` is mutated as bodies settle,
  // so re-sorting would let a widget that was just pushed down lose its place in
  // the queue and end up level with the widget above it.
  pending.sort((a, b) => a.y - b.y || widgets.indexOf(a) - widgets.indexOf(b));

  for (const head of pending) {
    // A group's child is displaced by its group, never tested on its own.
    if (head.groupId && settled.has(head.groupId)) continue;

    const body = bodyOf(head).map((memberId) => result.get(memberId) as WidgetPlacement);

    // Push the body below every settled body it overlaps. The shift is measured
    // per member against the blocker's BOTTOM, and re-checked until nothing
    // overlaps: one pass is not enough, because clearing the first blocker can
    // slide the body onto a second one that sits lower down.
    let guard = 0;
    let moved = true;
    while (moved && guard < widgets.length + 1) {
      guard += 1;
      moved = false;
      let shift = 0;
      for (const settledId of settled) {
        const blocker = result.get(settledId) as WidgetPlacement;
        for (const member of body) {
          if (!overlaps(blocker, member)) continue;
          shift = Math.max(shift, blocker.y + blocker.h - member.y);
        }
      }
      if (shift > 0) {
        for (const member of body) {
          member.y = Math.min(LAYOUT_MAX_ROWS - 1, member.y + shift);
        }
        moved = true;
      }
    }
    for (const member of body) settled.add(member.id);
  }

  return widgets.map((widget) => result.get(widget.id) as WidgetPlacement);
}

/** Re-evaluate membership after a drop or group resize. A normal widget joins
 * the smallest group that fully contains it; a group captures every widget
 * inside its frame and releases its former contents that no longer fit. */
export function reconcileWidgetGroup(
  widgets: WidgetPlacement[],
  id: string,
): WidgetPlacement[] {
  const target = widgets.find((widget) => widget.id === id);
  if (!target) return widgets;

  if (target.type === "layoutGroup") {
    return widgets.map((widget) => {
      if (widget.type === "layoutGroup") return widget;
      if (isInsideGroup(widget, target)) return { ...widget, groupId: target.id };
      if (widget.groupId !== target.id) return widget;
      const { groupId: _groupId, ...withoutGroup } = widget;
      return withoutGroup;
    });
  }

  const groupId = containingGroupId(widgets, target);
  if (groupId) return widgets.map((widget) => widget.id === id ? { ...widget, groupId } : widget);
  if (!target.groupId) return widgets;
  return widgets.map((widget) => {
    if (widget.id !== id) return widget;
    const { groupId: _groupId, ...withoutGroup } = widget;
    return withoutGroup;
  });
}

/** v4 offered the song header and clip list as separate widgets. When the
 * common one-of-each pair exists, preserve their combined rectangle and keep a
 * single fused compact-song widget. Lone legacy clip lists remain valid and
 * are rendered by the same combined component. */
function fuseLegacySongWidgets(widgets: WidgetPlacement[]): WidgetPlacement[] {
  const headers = widgets.filter((widget) => widget.type === "songHeader");
  const clipLists = widgets.filter((widget) => widget.type === "clipList");
  if (headers.length !== 1 || clipLists.length !== 1) {
    return widgets;
  }

  const header = headers[0];
  const clipList = clipLists[0];
  const x = Math.min(header.x, clipList.x);
  const y = Math.min(header.y, clipList.y);
  const right = Math.max(header.x + header.w, clipList.x + clipList.w);
  const bottom = Math.max(header.y + header.h, clipList.y + clipList.h);
  const fused: WidgetPlacement = {
    ...header,
    x,
    y,
    w: Math.min(LAYOUT_COLUMNS - x, right - x),
    h: Math.min(LAYOUT_MAX_ROWS - y, bottom - y),
  };

  return widgets
    .filter((widget) => widget.id !== clipList.id)
    .map((widget) => (widget.id === header.id ? fused : widget));
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
  const candidate = raw as { version?: unknown; tabs?: unknown; widgets?: unknown; activeTabId?: unknown; customized?: unknown; presetProfile?: unknown; placementMode?: unknown; tabHeightRem?: unknown };
  const placementMode: LayoutPlacementMode =
    candidate.placementMode === "push" ? "push" : "free";
  const tabHeightRem = clampTabHeight(candidate.tabHeightRem);
  const legacyGrid = typeof candidate.version !== "number" || candidate.version < 4;

  // v1 → v2 migration: a flat widgets array becomes a single tab.
  if (!Array.isArray(candidate.tabs) && Array.isArray(candidate.widgets)) {
    const widgets = fuseLegacySongWidgets(normalizeWidgets(candidate.widgets, legacyGrid));
    if (widgets.length === 0) {
      return defaultLayout();
    }
    const tab: LayoutTab = { id: newTabId(), name: "Principal", widgets };
    return { version: LAYOUT_VERSION, tabs: [tab], activeTabId: tab.id, placementMode, tabHeightRem };
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
    tabs.push({
      id,
      name,
      widgets: fuseLegacySongWidgets(normalizeWidgets(item.widgets, legacyGrid)),
    });
  }

  if (tabs.length === 0) {
    return defaultLayout();
  }

  const activeTabId =
    typeof candidate.activeTabId === "string" &&
    tabs.some((tab) => tab.id === candidate.activeTabId)
      ? candidate.activeTabId
      : tabs[0].id;

  return {
    version: LAYOUT_VERSION,
    tabs,
    activeTabId,
    customized: candidate.customized === true,
    presetProfile:
      candidate.presetProfile === "phone" ? "phone" :
      candidate.presetProfile === "tablet" ? "tablet" :
      candidate.presetProfile === "standard" ? "standard" : undefined,
    placementMode,
    tabHeightRem,
  };
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
    // Stored layouts may still carry their original schema number after being
    // migrated in memory. An export always advertises the schema it actually
    // writes, including layoutGroup placements and child groupId references.
    layout: { ...layout, version: LAYOUT_VERSION },
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

/** Pixel heights the fold calculation needs, all measured from the live DOM. */
export type FoldMetrics = {
  /** Height of the whole remote shell (the device viewport it occupies). */
  shellHeight: number;
  /** Full current height of the header, INCLUDING the edit toolbar if present. */
  headerHeight: number;
  /** Height of the edit toolbar, or 0 when not editing. */
  toolbarHeight: number;
  /** Tallest header child that is not the toolbar (the toolbar shares the
   * header's row, so only its excess over this adds height). */
  otherHeaderHeight: number;
  /** The tab strip: part of the real view, so it costs the grid height. */
  tabbarHeight: number;
  /** Vertical padding of the scroll container, safe-area inset included. */
  scrollerPadding: number;
  /** Height of one grid row including its gap. */
  rowHeight: number;
};

/**
 * The grid row where the player's screen ends, or null when the layout fits.
 *
 * Computed from the REAL view, never from the editor's: the edit toolbar is
 * injected into the header, the header is a flex sibling of the scroll
 * container's parent, and that parent is `flex: 1` — so a toolbar wrapping onto
 * several lines shrinks the scroller. Reading the scroller's height directly
 * therefore drifts the fold upward and reports scrolling on a phone that has
 * none. Only the toolbar's EXCESS over the rest of the header row counts as
 * editor-only chrome, because it occupies the header's flexible middle column.
 */
export function computeFoldRow(
  metrics: FoldMetrics,
  usedRows: number,
): number | null {
  const toolbarExcess = Math.max(
    0,
    metrics.toolbarHeight - metrics.otherHeaderHeight,
  );
  const realHeaderHeight = metrics.headerHeight - toolbarExcess;
  const realGridHeight =
    metrics.shellHeight -
    realHeaderHeight -
    metrics.tabbarHeight -
    metrics.scrollerPadding;
  if (metrics.rowHeight <= 0) return null;
  const visibleRows = Math.floor(realGridHeight / metrics.rowHeight);
  if (visibleRows <= 0) return null;
  return usedRows > visibleRows ? visibleRows : null;
}
