import { describe, expect, it } from "vitest";

import { focusLineState, lyricsFocus, parseFollowFocus, resolveFollow } from "./lyricsFollow";

const at = (focus: 1 | 2 | 3 | "section" | "off", currentLine: number | null, blockLineCount = 5, currentBlock = 2) =>
  lyricsFocus({ focus, currentBlock, currentLine, blockLineCount });

describe("lyricsFocus", () => {
  it("1 line: the current line, read at 18 %", () => {
    expect(at(1, 3)).toEqual({ lines: [3], anchor: { key: "2-3", align: "reading" } });
  });

  it("2 lines: fixed groups [0,1] [2,3] [4] in a part of 5, same anchor inside a group", () => {
    expect(at(2, 0)).toEqual({ lines: [0, 1], anchor: { key: "2-0", align: "reading" } });
    expect(at(2, 1)).toEqual(at(2, 0));
    expect(at(2, 2)).toEqual({ lines: [2, 3], anchor: { key: "2-2", align: "reading" } });
    expect(at(2, 3).anchor).toEqual(at(2, 2).anchor);
    // The last group does not reach into the next part.
    expect(at(2, 4)).toEqual({ lines: [4], anchor: { key: "2-4", align: "reading" } });
  });

  it("3 lines: [0,1,2] then [3,4]", () => {
    expect(at(3, 1).lines).toEqual([0, 1, 2]);
    expect(at(3, 4)).toEqual({ lines: [3, 4], anchor: { key: "2-3", align: "reading" } });
  });

  it("section: every line, header at the top", () => {
    expect(at("section", 3)).toEqual({ lines: "all", anchor: { key: "2-head", align: "top" } });
    expect(at("section", 0).anchor).toEqual(at("section", 4).anchor);
  });

  it("off: the current line, no anchor", () => {
    expect(at("off", 3)).toEqual({ lines: [3], anchor: null });
  });

  it("on the header (no line yet): nothing highlighted, the header anchors as today", () => {
    expect(at(1, null)).toEqual({ lines: [], anchor: { key: "2-head", align: "reading" } });
    expect(at(2, null).anchor).toEqual({ key: "2-head", align: "reading" });
    expect(at("section", null)).toEqual({ lines: [], anchor: { key: "2-head", align: "top" } });
    expect(at("off", null)).toEqual({ lines: [], anchor: null });
  });

  it("no current block: nothing", () => {
    expect(at(1, 0, 5, -1)).toEqual({ lines: [], anchor: null });
  });
});

describe("focusLineState", () => {
  it("lines of other blocks are past or upcoming; in the block, the focus is current", () => {
    const focus = at(2, 2);
    expect(focusLineState(focus, 1, 2, 0)).toBe("past");
    expect(focusLineState(focus, 3, 2, 0)).toBe("upcoming");
    expect([0, 1, 2, 3, 4].map((line) => focusLineState(focus, 2, 2, line))).toEqual(["past", "past", "current", "current", "upcoming"]);
    expect([0, 4].map((line) => focusLineState(at("section", 1), 2, 2, line))).toEqual(["current", "current"]);
  });
});

describe("resolveFollow", () => {
  it("the song's own follow wins; absent or unknown uses the general one", () => {
    expect(resolveFollow({ focus: "section" }, 1)).toBe("section");
    expect(resolveFollow(undefined, 3)).toBe(3);
    expect(resolveFollow(null, "off")).toBe("off");
    expect(resolveFollow({ focus: 7 as never }, 2)).toBe(2);
  });

  it("parses stored values", () => {
    expect(["1", "2", "3", "section", "off", "x", 4].map(parseFollowFocus)).toEqual([1, 2, 3, "section", "off", null, null]);
  });
});
