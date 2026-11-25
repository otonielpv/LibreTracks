import { describe, expect, it } from "vitest";

import cases from "./sectionLabels.cases.json";
import { canonicalLabel, sectionFamily, type LabelContext } from "./sectionVocab";

describe("the one vocabulary of section names", () => {
  it("has enough shared cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
  });

  // The same file Rust `written_labels_match_the_shared_cases` reads.
  it.each(cases.map((entry) => [entry.text, entry.context, entry.kind, entry.number] as const))(
    "%j (%s) names %s %s",
    (text, context, kind, number) => {
      const meaning = canonicalLabel(text, context as LabelContext);
      expect(meaning ? [meaning.kind, meaning.number] : [null, null]).toEqual([kind, kind ? number : null]);
    },
  );

  it("joins the names of the same part into families", () => {
    expect(sectionFamily("refrain")).not.toBe(sectionFamily("chorus"));
    expect(sectionFamily("turnaround")).toBe(sectionFamily("instrumental"));
    expect(sectionFamily("interlude")).toBe(sectionFamily("instrumental"));
    expect(sectionFamily("ending")).toBe(sectionFamily("outro"));
    expect(sectionFamily("vamp")).not.toBe(sectionFamily("chorus"));
    expect(sectionFamily("bridge")).not.toBe(sectionFamily("pre_chorus"));
    expect(sectionFamily("custom")).toBeNull();
  });
});
