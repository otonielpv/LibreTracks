import { describe, expect, it } from "vitest";

import type { TrackEq } from "../models";

import golden from "./__fixtures__/eqResponseGolden.json";
import { trackEqResponseDb } from "./eqResponse";

type GoldenCase = {
  name: string;
  sampleRate: number;
  eq: TrackEq;
  points: [number, number][];
};

// La tabla la vuelca el motor C++ (native/audio-engine-v2/tests/test_track_eq.cpp):
// la curva que se pinta tiene que ser la que suena (plan track-eq, D11).
describe("eqResponse matches the C++ golden table", () => {
  const cases = (golden as unknown as { cases: GoldenCase[] }).cases;

  it("covers every band kind at two sample rates", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const kinds = new Set(cases.flatMap((c) => c.eq.bands.map((b) => b.kind)));
    expect([...kinds].sort()).toEqual(
      ["highCut", "highShelf", "lowCut", "lowShelf", "notch", "peak"].sort(),
    );
  });

  for (const goldenCase of cases) {
    it(`${goldenCase.name} @ ${goldenCase.sampleRate} Hz`, () => {
      let worst = 0;
      for (const [hz, db] of goldenCase.points) {
        const got = trackEqResponseDb(goldenCase.eq, goldenCase.sampleRate, hz);
        worst = Math.max(worst, Math.abs(got - db));
      }
      expect(worst).toBeLessThanOrEqual(0.05);
    });
  }
});
