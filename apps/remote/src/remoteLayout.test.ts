import { beforeEach, describe, expect, it } from "vitest";

import {
  ALL_WIDGET_TYPES,
  LAYOUT_COLUMNS,
  clearStoredLayout,
  defaultLayout,
  normalizeLayout,
  readStoredLayout,
  writeStoredLayout,
} from "./remoteLayout";

describe("remoteLayout", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("default layout only references known widget types", () => {
    for (const widget of defaultLayout().widgets) {
      expect(ALL_WIDGET_TYPES).toContain(widget.type);
    }
  });

  it("normalizeLayout falls back to default for garbage input", () => {
    expect(normalizeLayout(null).widgets.length).toBeGreaterThan(0);
    expect(normalizeLayout("nope").widgets.length).toBeGreaterThan(0);
    expect(normalizeLayout({ widgets: "x" }).widgets.length).toBeGreaterThan(0);
    expect(normalizeLayout({ widgets: [] }).widgets.length).toBeGreaterThan(0);
  });

  it("drops unknown widget types (forward-compat) but keeps known ones", () => {
    const result = normalizeLayout({
      version: 1,
      widgets: [
        { id: "a", type: "timeline", w: 6, h: 1 },
        { id: "b", type: "from-a-newer-build", w: 2, h: 1 },
        { id: "c", type: "currentKey", w: 1, h: 1 },
      ],
    });
    expect(result.widgets.map((w) => w.type)).toEqual(["timeline", "currentKey"]);
  });

  it("clamps out-of-range spans", () => {
    const result = normalizeLayout({
      version: 1,
      widgets: [
        { id: "a", type: "timeline", w: 999, h: 0 },
        { id: "b", type: "currentKey", w: -3, h: 50 },
      ],
    });
    expect(result.widgets[0].w).toBe(LAYOUT_COLUMNS);
    expect(result.widgets[0].h).toBe(1);
    expect(result.widgets[1].w).toBe(1);
    expect(result.widgets[1].h).toBe(4);
  });

  it("round-trips through localStorage", () => {
    const layout = defaultLayout();
    writeStoredLayout(layout);
    const read = readStoredLayout();
    expect(read.widgets.map((w) => w.type)).toEqual(layout.widgets.map((w) => w.type));
  });

  it("reads the default layout when storage is empty", () => {
    expect(readStoredLayout().widgets.map((w) => w.type)).toEqual(
      defaultLayout().widgets.map((w) => w.type),
    );
  });

  it("clearStoredLayout removes the persisted layout", () => {
    writeStoredLayout(defaultLayout());
    clearStoredLayout();
    // Back to default (nothing stored).
    expect(readStoredLayout().widgets.map((w) => w.type)).toEqual(
      defaultLayout().widgets.map((w) => w.type),
    );
  });
});
