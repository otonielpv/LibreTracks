import { afterEach, describe, expect, it } from "vitest";
import type { SongView } from "@libretracks/shared/models";

import { useSongStore } from "../songStore";
import { landedAtSeconds } from "./songPackageImport";

function songWithRegions(regions: Array<{ id: string; startSeconds: number }>): SongView {
  return { regions } as unknown as SongView;
}

describe("landedAtSeconds", () => {
  afterEach(() => {
    useSongStore.setState({ song: null });
  });

  it("reports where the new song landed, not where it was asked for", () => {
    // Asked for 0:05, inside the first song: the backend moved it to the end.
    useSongStore.setState({
      song: songWithRegions([
        { id: "first", startSeconds: 0 },
        { id: "imported", startSeconds: 248 },
      ]),
    });
    expect(landedAtSeconds(new Set(["first"]), 5)).toBe(248);
  });

  it("takes the earliest region when an import adds several", () => {
    useSongStore.setState({
      song: songWithRegions([
        { id: "a", startSeconds: 0 },
        { id: "b", startSeconds: 300 },
        { id: "c", startSeconds: 200 },
      ]),
    });
    expect(landedAtSeconds(new Set(["a"]), 0)).toBe(200);
  });

  it("falls back to the requested position when nothing new is found", () => {
    useSongStore.setState({ song: songWithRegions([{ id: "a", startSeconds: 0 }]) });
    expect(landedAtSeconds(new Set(["a"]), 42)).toBe(42);
    useSongStore.setState({ song: null });
    expect(landedAtSeconds(new Set(), 7)).toBe(7);
  });
});
