import { describe, expect, it } from "vitest";

import {
  describeLead,
  makeLead,
  normalizeLead,
  presetKeyOf,
  sameLead,
} from "./leadTime";

describe("leadTime helpers", () => {
  it("treats missing, zero, negative and NaN amounts as no lead", () => {
    expect(normalizeLead(null)).toBeNull();
    expect(normalizeLead(undefined)).toBeNull();
    expect(normalizeLead({ unit: "beats", count: 0 })).toBeNull();
    expect(normalizeLead({ unit: "bars", count: -1 })).toBeNull();
    expect(normalizeLead({ unit: "seconds", seconds: Number.NaN })).toBeNull();
    expect(normalizeLead({ unit: "beats", count: 0.5 })).toEqual({ unit: "beats", count: 0.5 });
  });

  it("builds the stored shape for each unit", () => {
    expect(makeLead("beats", 2)).toEqual({ unit: "beats", count: 2 });
    expect(makeLead("bars", 1)).toEqual({ unit: "bars", count: 1 });
    expect(makeLead("seconds", 0.8)).toEqual({ unit: "seconds", seconds: 0.8 });
  });

  it("matches presets by unit and amount", () => {
    expect(presetKeyOf({ unit: "beats", count: 1 })).toBe("oneBeat");
    expect(presetKeyOf({ unit: "bars", count: 2 })).toBe("twoBars");
    expect(presetKeyOf({ unit: "beats", count: 3 })).toBeNull();
    // Same amount, other unit: not the same lead.
    expect(presetKeyOf({ unit: "seconds", seconds: 1 })).toBeNull();
    expect(presetKeyOf(null)).toBeNull();
    expect(sameLead(null, null)).toBe(true);
    expect(sameLead({ unit: "beats", count: 1 }, null)).toBe(false);
  });

  it("describes a lead with its unit", () => {
    const t = (key: string, options?: Record<string, unknown>) =>
      `${key}:${String(options?.amount)}`;
    expect(describeLead({ unit: "beats", count: 1 }, t)).toBe("transport.lead.amountBeats:1");
    expect(describeLead({ unit: "seconds", seconds: 0.75 }, t)).toBe(
      "transport.lead.amountSeconds:0.75",
    );
  });
});
