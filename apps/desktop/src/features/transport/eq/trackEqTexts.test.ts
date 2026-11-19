import { describe, expect, it } from "vitest";

import en from "../../../shared/i18n/en";
import es from "../../../shared/i18n/es";

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  return Object.entries(value as Record<string, unknown>).reduce(
    (out, [key, child]) => ({ ...out, ...flatten(child, prefix ? `${prefix}.${key}` : key) }),
    {},
  );
}

describe("eq texts", () => {
  const esTexts = flatten(es.eq, "eq");
  const enTexts = flatten(en.eq, "eq");

  it("Spanish and English have the same keys", () => {
    expect(Object.keys(esTexts).sort()).toEqual(Object.keys(enTexts).sort());
  });

  it("no long dashes in any of them", () => {
    for (const text of [...Object.values(esTexts), ...Object.values(enTexts)]) {
      expect(text).not.toContain("—");
    }
  });

  it("every band kind has a name", () => {
    for (const kind of ["lowCut", "lowShelf", "peak", "highShelf", "highCut", "notch"]) {
      expect(esTexts[`eq.kind.${kind}`]).toBeTruthy();
      expect(enTexts[`eq.kind.${kind}`]).toBeTruthy();
    }
  });
});
