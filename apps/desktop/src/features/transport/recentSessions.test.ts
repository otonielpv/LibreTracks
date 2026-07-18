// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRecentSessions,
  loadRecentSessions,
  pushRecentSession,
} from "./recentSessions";

describe("recentSessions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps the most recently opened path first and deduplicates it", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200);

    pushRecentSession("/storage/Music/Show/Show.ltsession");
    pushRecentSession("/STORAGE/music/show/show.ltsession");

    expect(loadRecentSessions()).toEqual([
      {
        path: "/STORAGE/music/show/show.ltsession",
        name: "show",
        openedAtMs: 200,
      },
    ]);
  });

  it("uses the containing folder for generic session filenames", () => {
    pushRecentSession("/storage/Music/My Set/import-session.ltsession");

    expect(loadRecentSessions()[0]?.name).toBe("My Set");
  });

  it("tolerates malformed storage and can clear the list", () => {
    window.localStorage.setItem("libretracks.recentSessions", "not-json");
    expect(loadRecentSessions()).toEqual([]);

    pushRecentSession("C:\\Sets\\Sunday\\Sunday.ltsession");
    clearRecentSessions();
    expect(loadRecentSessions()).toEqual([]);
  });
});
