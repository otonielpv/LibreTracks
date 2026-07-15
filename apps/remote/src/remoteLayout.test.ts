import { beforeEach, describe, expect, it } from "vitest";

import {
  ALL_WIDGET_TYPES,
  LAYOUT_COLUMNS,
  LAYOUT_MAX_ROWS,
  LAYOUT_VERSION,
  DEFAULT_METRONOME_WIDGET_HEIGHT,
  clearStoredLayout,
  containingGroupId,
  defaultLayout,
  layoutExportFilename,
  moveWidgetWithGroup,
  normalizeLayout,
  parseLayoutFile,
  readStoredLayout,
  reconcileWidgetGroup,
  serializeLayoutFile,
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
      ["pads", DEFAULT_METRONOME_WIDGET_HEIGHT + 14, 31],
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
});
