import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary, SongChart } from "../models";

import { finalizeImport, buildImportReview } from "./chartImportReview";
import { buildRefreshReview } from "./chartRefresh";
import type { ImportedChart } from "./importedChart";

const marker = (id: string, name: string, kind: SectionMarkerSummary["kind"]): SectionMarkerSummary => ({ id, name, startSeconds: 0, kind });
const SONG = [marker("v1", "Verso", "verse"), marker("c1", "Coro", "chorus"), marker("v2", "Verso", "verse"), marker("c2", "Coro", "chorus")];

const source = (updatedAt: string) => ({ provider: "planningCenter", songId: "s1", arrangementId: "a1", updatedAt, key: "G" }) as const;
const imported = (text: string, updatedAt: string): ImportedChart => ({ title: "T", text, key: "G", source: source(updatedAt) });

const OLD = ["VERSE 1", "[G]Uno", "CHORUS", "[C]Coro", "VERSE 2", "[G]Dos"].join("\n");

/** What an import saved, then the user fixed v2 to Verse 1 by hand. */
function saved(): SongChart {
  const review = buildImportReview(imported(OLD, "2026-11-20T10:00:00Z"), SONG, "G", [{ markerId: "v2", section: 0 }]);
  return finalizeImport(review, { transpose: false, linked: true });
}

describe("updating from the source", () => {
  it("C1: nothing changed in the source: up to date, nothing to save", () => {
    expect(buildRefreshReview(saved(), imported(OLD, "2026-11-20T10:00:00Z"), SONG, "G")).toEqual({ upToDate: true });
  });

  it("C2: a new Verse 3 shows as added and linked markers keep their section", () => {
    const fresh = imported(`${OLD}\nVERSE 3\n[G]Tres`, "2026-11-22T09:00:00Z");
    const result = buildRefreshReview(saved(), fresh, SONG, "G");
    if (result.upToDate) throw new Error("expected changes");
    expect(result.changes).toEqual([{ label: "Verse 3", change: "added" }]);
    expect(result.review.rows.find((row) => row.markerId === "v2")?.section).toBe(0);
    expect(result.review.rows.find((row) => row.markerId === "v2")?.reason).toBe("locked");
  });

  it("shows changed and removed sections", () => {
    const fresh = imported(["VERSE 1", "[G]Uno nuevo", "CHORUS", "[C]Coro"].join("\n"), "2026-11-22T09:00:00Z");
    const result = buildRefreshReview(saved(), fresh, SONG, "G");
    if (result.upToDate) throw new Error("expected changes");
    expect(result.changes).toEqual([
      { label: "Verse 1", change: "changed" },
      { label: "Verse 2", change: "removed" },
    ]);
  });

  it("C3: warns only when the text was edited here", () => {
    const fresh = imported(`${OLD}\nTAG\n[G]Fin`, "2026-11-22T09:00:00Z");
    const untouched = buildRefreshReview(saved(), fresh, SONG, "G");
    const edited = buildRefreshReview({ ...saved(), text: `${saved().text}\nUna línea mía` }, fresh, SONG, "G");
    expect(!untouched.upToDate && untouched.editedLocally).toBe(false);
    expect(!edited.upToDate && edited.editedLocally).toBe(true);
  });
});
