import { describe, expect, it } from "vitest";

import reference from "./fixtures/trackEqReference.json";
import type { EqBand, EqBandKind, TrackEq, TrackSummary } from "./models";

// El mismo JSON lo serializa y compara el core Rust
// (`crates/libretracks-core/src/track_eq_tests.rs`): si un lado renombra un
// campo, uno de los dos tests se pone rojo.
describe("TrackEq contract with Rust", () => {
  const eq: TrackEq = reference.trackEq as TrackEq;

  it("keeps the exact keys the Rust model writes", () => {
    expect(Object.keys(eq).sort()).toEqual(["bands", "enabled"]);
    const expectedBandKeys: (keyof EqBand)[] = ["enabled", "kind", "frequencyHz", "gainDb", "q", "slope"];
    for (const band of eq.bands) {
      expect(Object.keys(band).sort()).toEqual([...expectedBandKeys].sort());
    }
  });

  it("uses the six kind names of the Rust enum", () => {
    const kinds: EqBandKind[] = ["lowCut", "lowShelf", "peak", "notch", "highShelf", "highCut"];
    expect(eq.bands.map((band) => band.kind)).toEqual(kinds);
    expect(eq.bands.every((band) => band.slope === 12 || band.slope === 24)).toBe(true);
  });

  it("fits in a TrackSummary", () => {
    const track: Pick<TrackSummary, "id" | "eq"> = { id: "t1", eq };
    expect(track.eq?.bands).toHaveLength(6);
  });
});
