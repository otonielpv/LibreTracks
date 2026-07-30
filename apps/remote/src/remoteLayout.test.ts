import { beforeEach, describe, expect, it } from "vitest";

import {
  ALL_WIDGET_TYPES,
  LAYOUT_COLUMNS,
  LAYOUT_MAX_ROWS,
  LAYOUT_VERSION,
  DEFAULT_METRONOME_WIDGET_HEIGHT,
  DEFAULT_PADS_WIDGET_HEIGHT,
  clearStoredLayout,
  containingGroupId,
  defaultLayout,
  layoutExportFilename,
  moveWidgetWithGroup,
  normalizeLayout,
  parseLayoutFile,
  pushWidgetsDown,
  rectContainsPoint,
  readStoredLayout,
  reconcileWidgetGroup,
  serializeLayoutFile,
  clampTabHeight,
  DEFAULT_TAB_HEIGHT_REM,
  TAB_HEIGHT_MAX_REM,
  TAB_HEIGHT_MIN_REM,
  writeStoredLayout,
  type RemoteLayout,
} from "./remoteLayout";

/** All widget placements across every tab, in tab order. */
function allWidgets(layout: RemoteLayout) {
  return layout.tabs.flatMap((tab) => tab.widgets);
}

describe("remoteLayout", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("default layout includes controls, mixer and performance tools", () => {
    const layout = defaultLayout();
    expect(layout.tabs.map((t) => t.name)).toEqual(["Controles", "Mixer", "Herramientas"]);
    expect(layout.tabs[2].widgets.map((widget) => widget.type)).toEqual([
      "metronomeSettings",
      "voiceGuideSettings",
      "pads",
    ]);
    expect(layout.tabs[2].widgets[0].h).toBe(DEFAULT_METRONOME_WIDGET_HEIGHT);
    expect(layout.activeTabId).toBe(layout.tabs[0].id);
    for (const widget of allWidgets(layout)) {
      expect(ALL_WIDGET_TYPES).toContain(widget.type);
    }
    // No live/counter widgets in the default (opt-in from the palette only).
    const liveTypes = new Set([
      "countdownMarkerBars",
      "countdownSongTime",
      "progressMarker",
      "progressSong",
      "nextMarker",
      "nextSong",
      "currentKey",
    ]);
    expect(allWidgets(layout).some((w) => liveTypes.has(w.type))).toBe(false);
  });

  it("normalizeLayout falls back to default for garbage input", () => {
    expect(normalizeLayout(null).tabs.length).toBeGreaterThan(0);
    expect(normalizeLayout("nope").tabs.length).toBeGreaterThan(0);
    expect(normalizeLayout({ tabs: "x" }).tabs.length).toBeGreaterThan(0);
    expect(normalizeLayout({ tabs: [] }).tabs.length).toBeGreaterThan(0);
  });

  it("default widgets all have x/y coordinates", () => {
    for (const widget of allWidgets(defaultLayout())) {
      expect(Number.isFinite(widget.x)).toBe(true);
      expect(Number.isFinite(widget.y)).toBe(true);
      expect(widget.x).toBeGreaterThanOrEqual(0);
      expect(widget.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses a compact intermediate geometry for the tablet preset", () => {
    const widgets = defaultLayout("tablet").tabs[0].widgets;
    expect(widgets.map(({ type, y, h }) => [type, y, h])).toEqual([
      ["readouts", 0, 3],
      ["transportButtons", 3, 3],
      ["timeline", 6, 4],
      ["controlDeck", 10, 7],
      ["markerGrid", 17, 10],
    ]);
  });

  it("gives every default metronome enough height without overlapping phone tools", () => {
    for (const profile of ["standard", "tablet", "phone"] as const) {
      const tools = defaultLayout(profile).tabs[2].widgets;
      expect(tools.find((widget) => widget.type === "metronomeSettings")?.h)
        .toBe(DEFAULT_METRONOME_WIDGET_HEIGHT);
    }

    const phoneTools = defaultLayout("phone").tabs[2].widgets;
    expect(phoneTools.map(({ type, y, h }) => [type, y, h])).toEqual([
      ["metronomeSettings", 0, DEFAULT_METRONOME_WIDGET_HEIGHT],
      ["voiceGuideSettings", DEFAULT_METRONOME_WIDGET_HEIGHT, 14],
      ["pads", DEFAULT_METRONOME_WIDGET_HEIGHT + 14, DEFAULT_PADS_WIDGET_HEIGHT],
    ]);
  });

  it("auto-places widgets that lack x/y (migration from the flow model)", () => {
    // Three full-width widgets with no x/y should stack in rows 0,1,2 at col 0.
    const migrated = normalizeLayout({
      version: 2,
      activeTabId: "t1",
      tabs: [
        {
          id: "t1",
          name: "T",
          widgets: [
            { id: "a", type: "timeline", w: 6, h: 1 },
            { id: "b", type: "controlDeck", w: 6, h: 1 },
            { id: "c", type: "markerGrid", w: 6, h: 1 },
          ],
        },
      ],
    });
    expect(migrated.tabs[0].widgets.map((w) => [w.x, w.y])).toEqual([
      [0, 0],
      [0, 4],
      [0, 8],
    ]);
  });

  it("fuses a legacy song header and clip list into their combined rectangle", () => {
    const result = normalizeLayout({
      version: 4,
      activeTabId: "songs",
      tabs: [{
        id: "songs",
        name: "Songs",
        widgets: [
          { id: "header", type: "songHeader", x: 0, y: 2, w: 24, h: 4 },
          { id: "clips", type: "clipList", x: 0, y: 6, w: 24, h: 8 },
        ],
      }],
    });

    expect(result.tabs[0].widgets).toEqual([
      { id: "header", type: "songHeader", x: 0, y: 2, w: 24, h: 12 },
    ]);
  });

  it("auto-place wraps narrow widgets across columns before the next row", () => {
    const migrated = normalizeLayout({
      version: 2,
      activeTabId: "t1",
      tabs: [
        {
          id: "t1",
          name: "T",
          // Two width-2 widgets then a width-6: 2+2 fit row 0 (cols 0,2), the
          // width-6 wraps to row 1.
          widgets: [
            { id: "a", type: "currentKey", w: 2, h: 1 },
            { id: "b", type: "nextSong", w: 2, h: 1 },
            { id: "c", type: "timeline", w: 6, h: 1 },
          ],
        },
      ],
    });
    expect(migrated.tabs[0].widgets.map((w) => [w.x, w.y])).toEqual([
      [0, 0],
      [8, 0],
      [0, 4],
    ]);
  });

  it("keeps and clamps explicit x/y", () => {
    const result = normalizeLayout({
      version: 3,
      activeTabId: "t1",
      tabs: [
        {
          id: "t1",
          name: "T",
          widgets: [
            { id: "a", type: "currentKey", x: 3, y: 2, w: 1, h: 1 },
            { id: "b", type: "nextSong", x: 99, y: -5, w: 1, h: 1 },
          ],
        },
      ],
    });
    const [a, b] = result.tabs[0].widgets;
    expect([a.x, a.y]).toEqual([12, 8]);
    expect(b.x).toBe(LAYOUT_COLUMNS - 1);
    expect(b.y).toBe(0);
  });

  it("migrates a v1 flat layout into a single 'Principal' tab", () => {
    const migrated = normalizeLayout({
      version: 1,
      widgets: [
        { id: "a", type: "timeline", w: 6, h: 1 },
        { id: "c", type: "currentKey", w: 1, h: 1 },
      ],
    });
    expect(migrated.tabs).toHaveLength(1);
    expect(migrated.tabs[0].name).toBe("Principal");
    expect(migrated.tabs[0].widgets.map((w) => w.type)).toEqual([
      "timeline",
      "currentKey",
    ]);
    expect(migrated.activeTabId).toBe(migrated.tabs[0].id);
  });

  it("keeps multiple tabs and preserves a valid activeTabId", () => {
    const result = normalizeLayout({
      version: 2,
      activeTabId: "t2",
      tabs: [
        { id: "t1", name: "Controls", widgets: [{ id: "a", type: "timeline", w: 6, h: 1 }] },
        { id: "t2", name: "Mixer", widgets: [{ id: "b", type: "mixer", w: 6, h: 2 }] },
      ],
    });
    expect(result.tabs.map((t) => t.name)).toEqual(["Controls", "Mixer"]);
    expect(result.activeTabId).toBe("t2");
  });

  it("resets a stale activeTabId to the first tab", () => {
    const result = normalizeLayout({
      version: 2,
      activeTabId: "does-not-exist",
      tabs: [{ id: "t1", name: "Only", widgets: [{ id: "a", type: "timeline", w: 6, h: 1 }] }],
    });
    expect(result.activeTabId).toBe("t1");
  });

  it("drops unknown widget types inside a tab (forward-compat)", () => {
    const result = normalizeLayout({
      version: 2,
      activeTabId: "t1",
      tabs: [
        {
          id: "t1",
          name: "T",
          widgets: [
            { id: "a", type: "timeline", w: 6, h: 1 },
            { id: "b", type: "from-a-newer-build", w: 2, h: 1 },
            { id: "c", type: "currentKey", w: 1, h: 1 },
          ],
        },
      ],
    });
    expect(result.tabs[0].widgets.map((w) => w.type)).toEqual(["timeline", "currentKey"]);
  });

  it("preserves only valid configuration for design widgets", () => {
    const result = normalizeLayout({
      version: 4,
      activeTabId: "design",
      tabs: [{
        id: "design",
        name: "Design",
        widgets: [
          {
            id: "title",
            type: "layoutTitle",
            x: 0, y: 0, w: 24, h: 3,
            config: { text: "Directo", align: "center", separatorStyle: "dashed", unknown: true },
          },
          {
            id: "separator",
            type: "separator",
            x: 0, y: 3, w: 24, h: 2,
            config: { separatorStyle: "dashed", text: "ignored" },
          },
          {
            id: "invalid",
            type: "layoutNote",
            x: 0, y: 5, w: 12, h: 6,
            config: { align: "sideways", separatorStyle: "rainbow" },
          },
        ],
      }],
    });

    expect(result.tabs[0].widgets.map((widget) => widget.config)).toEqual([
      { text: "Directo", align: "center" },
      { separatorStyle: "dashed" },
      undefined,
    ]);
  });

  it("groups contained widgets and moves them with the group", () => {
    const widgets = [
      { id: "group", type: "layoutGroup" as const, x: 0, y: 0, w: 12, h: 12 },
      { id: "inside", type: "currentKey" as const, x: 2, y: 3, w: 4, h: 4 },
      { id: "outside", type: "nextSong" as const, x: 14, y: 3, w: 4, h: 4 },
    ];
    const grouped = reconcileWidgetGroup(widgets, "group");
    expect(grouped.find((widget) => widget.id === "inside")?.groupId).toBe("group");
    expect(grouped.find((widget) => widget.id === "outside")?.groupId).toBeUndefined();

    const moved = moveWidgetWithGroup(grouped, "group", 5, 6);
    expect(moved.find((widget) => widget.id === "group")).toMatchObject({ x: 5, y: 6 });
    expect(moved.find((widget) => widget.id === "inside")).toMatchObject({ x: 7, y: 9 });
    expect(moved.find((widget) => widget.id === "outside")).toMatchObject({ x: 14, y: 3 });

    const childOutside = moveWidgetWithGroup(moved, "inside", 20, 20);
    const ungrouped = reconcileWidgetGroup(childOutside, "inside");
    expect(ungrouped.find((widget) => widget.id === "inside")?.groupId).toBeUndefined();
  });

  it("uses the visible group content area and reserves its title rows", () => {
    const group = { id: "group", type: "layoutGroup" as const, x: 0, y: 4, w: 12, h: 12 };
    const belowTitle = { id: "inside", type: "currentKey" as const, x: 1, y: 6, w: 4, h: 4 };
    const overTitle = { id: "title-overlap", type: "currentKey" as const, x: 1, y: 5, w: 4, h: 4 };

    expect(containingGroupId([group, belowTitle], belowTitle)).toBe("group");
    expect(containingGroupId([group, overTitle], overTitle)).toBeNull();
  });

  it("drops stale group references when importing a layout", () => {
    const result = normalizeLayout({
      version: 4,
      activeTabId: "t",
      tabs: [{
        id: "t",
        name: "Groups",
        widgets: [
          { id: "group", type: "layoutGroup", x: 0, y: 0, w: 12, h: 12 },
          { id: "valid", type: "currentKey", x: 1, y: 1, w: 4, h: 4, groupId: "group" },
          { id: "stale", type: "nextSong", x: 14, y: 1, w: 4, h: 4, groupId: "missing" },
        ],
      }],
    });
    expect(result.tabs[0].widgets.find((widget) => widget.id === "valid")?.groupId).toBe("group");
    expect(result.tabs[0].widgets.find((widget) => widget.id === "stale")?.groupId).toBeUndefined();
  });

  it("clamps out-of-range spans", () => {
    const result = normalizeLayout({
      version: 2,
      activeTabId: "t1",
      tabs: [
        {
          id: "t1",
          name: "T",
          widgets: [
            { id: "a", type: "timeline", w: 999, h: 0 },
            { id: "b", type: "currentKey", w: -3, h: 50 },
          ],
        },
      ],
    });
    const [a, b] = result.tabs[0].widgets;
    expect(a.w).toBe(LAYOUT_COLUMNS);
    expect(a.h).toBe(1);
    expect(b.w).toBe(1);
    expect(b.h).toBe(LAYOUT_MAX_ROWS);
  });

  it("round-trips through localStorage", () => {
    const layout = defaultLayout();
    writeStoredLayout(layout);
    const read = readStoredLayout();
    expect(allWidgets(read).map((w) => w.type)).toEqual(allWidgets(layout).map((w) => w.type));
  });

  it("reads the default layout when storage is empty", () => {
    expect(allWidgets(readStoredLayout()).map((w) => w.type)).toEqual(
      allWidgets(defaultLayout()).map((w) => w.type),
    );
  });

  it("clearStoredLayout removes the persisted layout", () => {
    writeStoredLayout(defaultLayout());
    clearStoredLayout();
    expect(allWidgets(readStoredLayout()).map((w) => w.type)).toEqual(
      allWidgets(defaultLayout()).map((w) => w.type),
    );
  });

  it("export/import round-trips a tabbed layout through a file", () => {
    const layout = defaultLayout();
    const text = serializeLayoutFile(layout);
    const imported = parseLayoutFile(text);
    expect(imported.tabs.map((t) => t.name)).toEqual(layout.tabs.map((t) => t.name));
    expect(allWidgets(imported).map((w) => `${w.type}:${w.w}x${w.h}`)).toEqual(
      allWidgets(layout).map((w) => `${w.type}:${w.w}x${w.h}`),
    );
  });

  it("exports group frames and child membership in the raw file and round-trips them", () => {
    const layout: RemoteLayout = {
      version: 4,
      activeTabId: "group-tab",
      customized: true,
      tabs: [{
        id: "group-tab",
        name: "Groups",
        widgets: [
          {
            id: "band",
            type: "layoutGroup",
            x: 0, y: 0, w: 16, h: 14,
            config: { text: "Banda", align: "center" },
          },
          {
            id: "transport",
            type: "transportButtons",
            x: 1, y: 3, w: 14, h: 5,
            groupId: "band",
          },
        ],
      }],
    };

    const text = serializeLayoutFile(layout);
    const raw = JSON.parse(text) as {
      version: number;
      layout: RemoteLayout;
    };
    expect(raw.version).toBe(LAYOUT_VERSION);
    expect(raw.layout.version).toBe(LAYOUT_VERSION);
    expect(raw.layout.tabs[0].widgets[0]).toMatchObject({
      id: "band",
      type: "layoutGroup",
      config: { text: "Banda", align: "center" },
    });
    expect(raw.layout.tabs[0].widgets[1]).toMatchObject({
      id: "transport",
      groupId: "band",
    });

    const imported = parseLayoutFile(text);
    expect(imported.tabs[0].widgets.find((widget) => widget.id === "band")?.type)
      .toBe("layoutGroup");
    expect(imported.tabs[0].widgets.find((widget) => widget.id === "transport")?.groupId)
      .toBe("band");
  });

  it("imports a v1 file and migrates it to tabs", () => {
    const text = JSON.stringify({
      kind: "libretracks.remote.layout",
      version: 1,
      layout: {
        version: 1,
        widgets: [
          { id: "a", type: "timeline", w: 6, h: 1 },
          { id: "z", type: "ghost-from-future", w: 2, h: 1 },
        ],
      },
    });
    const imported = parseLayoutFile(text);
    expect(imported.tabs).toHaveLength(1);
    expect(imported.tabs[0].widgets.map((w) => w.type)).toEqual(["timeline"]);
  });

  it("parseLayoutFile rejects non-JSON and unrelated JSON", () => {
    expect(() => parseLayoutFile("not json")).toThrow("invalid-json");
    expect(() => parseLayoutFile(JSON.stringify({ hello: "world" }))).toThrow(
      "not-a-layout-file",
    );
    expect(() => parseLayoutFile(JSON.stringify({ kind: "something-else" }))).toThrow(
      "not-a-layout-file",
    );
  });

  it("export filename is filesystem-friendly", () => {
    expect(layoutExportFilename()).toMatch(/^libretracks-remote-layout-[\d-]+\.json$/);
  });

  it("normalizes the placement mode and tab height with v5 defaults", () => {
    // A v5 layout predates both fields and must load with the old behaviour.
    const bare = normalizeLayout({
      version: 5,
      tabs: [{ id: "t", name: "T", widgets: [] }],
      activeTabId: "t",
    });
    expect(bare.placementMode).toBe("free");
    expect(bare.tabHeightRem).toBe(DEFAULT_TAB_HEIGHT_REM);

    const custom = normalizeLayout({
      version: 6,
      tabs: [{ id: "t", name: "T", widgets: [] }],
      activeTabId: "t",
      placementMode: "push",
      tabHeightRem: 3.1,
    });
    expect(custom.placementMode).toBe("push");
    expect(custom.tabHeightRem).toBeCloseTo(3.1);

    // Unknown mode / out-of-range height fall back rather than corrupting the UI.
    const bogus = normalizeLayout({
      version: 6,
      tabs: [{ id: "t", name: "T", widgets: [] }],
      activeTabId: "t",
      placementMode: "sideways",
      tabHeightRem: 99,
    });
    expect(bogus.placementMode).toBe("free");
    expect(bogus.tabHeightRem).toBe(TAB_HEIGHT_MAX_REM);
  });

  it("clamps and quantises the tab height", () => {
    expect(clampTabHeight(0.1)).toBe(TAB_HEIGHT_MIN_REM);
    expect(clampTabHeight(50)).toBe(TAB_HEIGHT_MAX_REM);
    expect(clampTabHeight("big")).toBe(DEFAULT_TAB_HEIGHT_REM);
    expect(clampTabHeight(Number.NaN)).toBe(DEFAULT_TAB_HEIGHT_REM);
    // Repeated 0.3 steps drift in float; the 0.1 snap keeps them comparable.
    expect(clampTabHeight(1.9 + 0.3 + 0.3)).toBeCloseTo(2.5);
  });
});

describe("rectContainsPoint", () => {
  const rect = { left: 100, right: 300, top: 500, bottom: 560, width: 200 };

  it("matches points inside, including the edges", () => {
    expect(rectContainsPoint(rect, 200, 530)).toBe(true);
    expect(rectContainsPoint(rect, 100, 500)).toBe(true);
    expect(rectContainsPoint(rect, 300, 560)).toBe(true);
  });

  it("rejects points outside on either axis", () => {
    expect(rectContainsPoint(rect, 99, 530)).toBe(false);
    expect(rectContainsPoint(rect, 301, 530)).toBe(false);
    expect(rectContainsPoint(rect, 200, 499)).toBe(false);
    expect(rectContainsPoint(rect, 200, 561)).toBe(false);
  });

  it("never matches an unlaid-out or missing rect", () => {
    // A zero-width rect is what an unmounted/unstyled element reports; treating
    // it as a hit would arm the trash zone for every drag.
    expect(rectContainsPoint({ ...rect, width: 0 }, 200, 530)).toBe(false);
    expect(rectContainsPoint(null, 200, 530)).toBe(false);
    expect(rectContainsPoint(undefined, 200, 530)).toBe(false);
  });

  it("rejects non-finite coordinates", () => {
    // Pointer math can produce NaN when the grid has not been measured yet.
    expect(rectContainsPoint(rect, Number.NaN, 530)).toBe(false);
    expect(rectContainsPoint(rect, 200, Number.NaN)).toBe(false);
  });
});

describe("pushWidgetsDown", () => {
  const at = (id: string, x: number, y: number, w: number, h: number) =>
    ({ id, type: "spacer", x, y, w, h }) as const;

  it("pushes an overlapped widget just far enough to clear the anchor", () => {
    // A dropped at y=0 covering rows 0-3; B sits at rows 2-3 → must land at 4.
    const result = pushWidgetsDown(
      [at("a", 0, 0, 12, 4), at("b", 0, 2, 12, 2)],
      "a",
    );
    expect(result.find((w) => w.id === "a")).toMatchObject({ x: 0, y: 0 });
    expect(result.find((w) => w.id === "b")).toMatchObject({ x: 0, y: 4 });
  });

  it("cascades: a pushed widget pushes whatever sits below it", () => {
    const result = pushWidgetsDown(
      [at("a", 0, 0, 12, 4), at("b", 0, 2, 12, 2), at("c", 0, 4, 12, 2)],
      "a",
    );
    // B → 4 (clears A), which now overlaps C, so C → 6.
    expect(result.find((w) => w.id === "b")?.y).toBe(4);
    expect(result.find((w) => w.id === "c")?.y).toBe(6);
  });

  it("stacks every displaced widget instead of fusing them", () => {
    // Regression: dropping a tall full-width widget at row 0 of the default
    // Controles stack used to leave the first two widgets BOTH starting at the
    // same row (visually fused). Each displaced widget must land below the
    // previous one, not merely below the anchor.
    const stack = [
      at("readouts", 0, 0, 24, 4),
      at("transport", 0, 4, 24, 5),
      at("timeline", 0, 9, 24, 7),
    ];
    const dropped = [...stack, at("deck", 0, 0, 24, 9)];
    const out = pushWidgetsDown(dropped, "deck");
    const y = (id: string) => out.find((w) => w.id === id) as { y: number; h: number };

    expect(y("deck")).toMatchObject({ y: 0 });
    // Below the anchor, in their original order, with no two sharing a row.
    expect(y("readouts").y).toBe(9);
    expect(y("transport").y).toBe(y("readouts").y + y("readouts").h);
    expect(y("timeline").y).toBe(y("transport").y + y("transport").h);
  });

  it("clears a second blocker that the first shift slides it onto", () => {
    // One pass is not enough: clearing `high` moves the widget onto `low`, so
    // the shift has to be re-evaluated until nothing overlaps.
    const widgets = [
      at("anchor", 0, 0, 24, 3),
      at("low", 0, 6, 24, 3),
      at("mover", 0, 1, 24, 2),
    ];
    const out = pushWidgetsDown(widgets, "anchor");
    const mover = out.find((w) => w.id === "mover") as { y: number };
    const low = out.find((w) => w.id === "low") as { y: number; h: number };
    // mover cleared the anchor (→3), which is above low (6-8): no overlap, so it
    // stays at 3 and low is untouched.
    expect(mover.y).toBe(3);
    expect(low.y).toBe(6);
  });

  it("leaves widgets in other columns alone", () => {
    const result = pushWidgetsDown(
      [at("a", 0, 0, 12, 4), at("side", 12, 0, 12, 4)],
      "a",
    );
    expect(result.find((w) => w.id === "side")).toMatchObject({ x: 12, y: 0 });
  });

  it("never moves the anchor itself", () => {
    const result = pushWidgetsDown(
      [at("under", 0, 0, 24, 6), at("a", 0, 3, 24, 3)],
      "a",
    );
    expect(result.find((w) => w.id === "a")).toMatchObject({ x: 0, y: 3 });
    // The widget the anchor landed on moves down; the anchor stays put.
    expect(result.find((w) => w.id === "under")?.y).toBe(6);
  });

  it("moves a group and its contents as one body", () => {
    const widgets = [
      { id: "g", type: "layoutGroup" as const, x: 0, y: 0, w: 24, h: 8 },
      { id: "child", type: "spacer" as const, x: 1, y: 2, w: 6, h: 2, groupId: "g" },
      { id: "a", type: "spacer" as const, x: 0, y: 0, w: 24, h: 3 },
    ];
    const result = pushWidgetsDown(widgets, "a");
    const group = result.find((w) => w.id === "g");
    const child = result.find((w) => w.id === "child");
    // The group clears the anchor (rows 0-2) and the child keeps its offset
    // inside the group: it was 2 rows below the frame, and still is.
    expect(group?.y).toBe(3);
    expect((child as { y: number }).y - (group as { y: number }).y).toBe(2);
  });

  it("never pushes a group's own children away from it", () => {
    // Dragging a group: its children overlap it by definition, and must ride
    // along instead of being shoved out of the frame.
    const widgets = [
      { id: "g", type: "layoutGroup" as const, x: 0, y: 4, w: 24, h: 8 },
      { id: "child", type: "spacer" as const, x: 1, y: 6, w: 6, h: 2, groupId: "g" },
    ];
    expect(pushWidgetsDown(widgets, "g")).toEqual(widgets);
  });

  it("is idempotent from a fixed baseline (live drag preview)", () => {
    // The editor previews a push on every pointer-move. It always re-applies the
    // dragged rectangle onto the pre-gesture BASELINE and pushes once, so
    // repeating the same frame must not walk the neighbours further down.
    const baseline = [at("a", 0, 0, 24, 2), at("b", 0, 2, 24, 2), at("c", 0, 4, 24, 2)];
    const frame = (h: number) =>
      pushWidgetsDown(
        baseline.map((widget) => (widget.id === "a" ? { ...widget, h } : widget)),
        "a",
      );

    const first = frame(5);
    const repeat = frame(5);
    expect(repeat).toEqual(first);
    expect(first.find((w) => w.id === "b")?.y).toBe(5);
    expect(first.find((w) => w.id === "c")?.y).toBe(7);

    // Shrinking back mid-drag must return the neighbours to where they started,
    // not leave them pushed — the baseline is what makes that possible.
    expect(frame(2)).toEqual(baseline);
  });

  it("returns the input untouched when nothing overlaps", () => {
    const widgets = [at("a", 0, 0, 12, 2), at("b", 0, 4, 12, 2)];
    const result = pushWidgetsDown(widgets, "a");
    expect(result).toEqual(widgets);
  });

  it("is a no-op for an unknown id", () => {
    const widgets = [at("a", 0, 0, 12, 2)];
    expect(pushWidgetsDown(widgets, "nope")).toBe(widgets);
  });

  it("clamps a cascade that would run past the last row", () => {
    const result = pushWidgetsDown(
      [at("a", 0, LAYOUT_MAX_ROWS - 2, 12, 2), at("b", 0, LAYOUT_MAX_ROWS - 1, 12, 2)],
      "a",
    );
    expect(result.find((w) => w.id === "b")?.y).toBeLessThanOrEqual(LAYOUT_MAX_ROWS - 1);
  });
});
