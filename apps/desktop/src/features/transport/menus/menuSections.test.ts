import { describe, expect, it } from "vitest";

import type { ContextMenuAction } from "../types";
import { menuSection, startsMenuGroup } from "./menuSections";

const action = (label: string): ContextMenuAction => ({ label, onSelect: () => {} });

describe("menu sections", () => {
  it("tags every entry with its heading", () => {
    expect(menuSection("Song", [action("a"), action("b")]).map((entry) => entry.section)).toEqual([
      "Song",
      "Song",
    ]);
  });

  it("starts a group where the section changes, and a loose entry after one", () => {
    const actions = [
      action("open"),
      ...menuSection("Song", [action("rename"), action("cover")]),
      ...menuSection("Export", [action("export")]),
      action("delete"),
    ];
    expect(actions.map((_, index) => startsMenuGroup(actions, index))).toEqual([
      false,
      true,
      false,
      true,
      true,
    ]);
  });

  it("a menu that opens with a section shows its heading first", () => {
    const actions = menuSection("Edit", [action("split")]);
    expect(startsMenuGroup(actions, 0)).toBe(true);
  });
});
