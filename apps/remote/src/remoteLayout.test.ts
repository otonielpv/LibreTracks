import { beforeEach, describe, expect, it } from "vitest";

import {
  ALL_WIDGET_TYPES,
  LAYOUT_COLUMNS,
  clearStoredLayout,
  defaultLayout,
  layoutExportFilename,
  normalizeLayout,
  parseLayoutFile,
  readStoredLayout,
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

  it("default layout is the classic two tabs (Controles + Mixer) of known widgets", () => {
    const layout = defaultLayout();
    expect(layout.tabs.map((t) => t.name)).toEqual(["Controles", "Mixer"]);
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
    expect(b.h).toBe(4);
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
