import { describe, expect, it } from "vitest";

import {
  COMPACT_COLUMN_DEFAULT_WIDTH_REM,
  COMPACT_COLUMN_MAX_WIDTH_REM,
  COMPACT_COLUMN_MIN_WIDTH_REM,
} from "@libretracks/shared/models";

import {
  autoColumnWidthRem,
  baselineColumnWidthRem,
  clampColumnWidthRem,
  columnDensityClass,
  measureSongNameWidthPx,
  COMPACT_COLUMN_NARROW_WIDTH_REM,
  COMPACT_COLUMN_VERY_NARROW_WIDTH_REM,
  resolveColumnWidthRem,
} from "./useColumnResize";

describe("clampColumnWidthRem", () => {
  it("keeps a width inside the supported range", () => {
    expect(clampColumnWidthRem(20)).toBe(20);
  });

  it("clamps up to the baseline, not to the absolute minimum", () => {
    // The UI floor is the baseline: a column can never be dragged narrower
    // than its own header needs, even though the backend would accept less.
    expect(clampColumnWidthRem(1)).toBe(baselineColumnWidthRem());
    expect(clampColumnWidthRem(COMPACT_COLUMN_MIN_WIDTH_REM)).toBe(
      baselineColumnWidthRem(),
    );
  });

  it("clamps above the maximum", () => {
    expect(clampColumnWidthRem(1000)).toBe(COMPACT_COLUMN_MAX_WIDTH_REM);
  });

  it("falls back to the default for a non-finite width", () => {
    // A hand-edited session (or a divide-by-zero in a future caller) must not
    // be able to render a column at NaN rem, which collapses it entirely.
    expect(clampColumnWidthRem(Number.NaN)).toBe(
      COMPACT_COLUMN_DEFAULT_WIDTH_REM,
    );
    expect(clampColumnWidthRem(Number.POSITIVE_INFINITY)).toBe(
      COMPACT_COLUMN_DEFAULT_WIDTH_REM,
    );
  });
});

describe("resolveColumnWidthRem", () => {
  it("falls back to the baseline when nothing else is supplied", () => {
    expect(resolveColumnWidthRem(null)).toBe(baselineColumnWidthRem());
    expect(resolveColumnWidthRem(undefined)).toBe(baselineColumnWidthRem());
  });

  it("uses the auto-fit width when there is no persisted width", () => {
    expect(resolveColumnWidthRem(null, 26)).toBe(26);
  });

  it("lets a persisted width override the auto-fit one", () => {
    // Once the user has dragged a column, its width is theirs — a long title
    // must not re-widen it on the next render. (Picked above the baseline so
    // the floor isn't what this test is measuring.)
    const narrower = baselineColumnWidthRem() + 1;
    expect(resolveColumnWidthRem(narrower, 26)).toBe(narrower);
  });

  it("uses the persisted width when there is one", () => {
    expect(resolveColumnWidthRem(24)).toBe(24);
  });

  it("clamps a persisted width from outside the supported range", () => {
    // Sessions written by a future build (or edited by hand) still have to
    // render something usable rather than a 200rem column.
    expect(resolveColumnWidthRem(500)).toBe(COMPACT_COLUMN_MAX_WIDTH_REM);
    expect(resolveColumnWidthRem(0)).toBe(baselineColumnWidthRem());
  });

  it("lifts a too-narrow persisted width up to the baseline", () => {
    // A width saved by an older build (when the floor was 5rem) must render
    // at the baseline rather than reproducing the cramped column.
    expect(resolveColumnWidthRem(6)).toBe(baselineColumnWidthRem());
  });
});

describe("autoColumnWidthRem", () => {
  // jsdom's canvas has no real text metrics unless `canvas` is installed, so
  // measureText returns 0 and the helper falls back. Both paths matter: the
  // fallback is what jsdom/SSR gets, the measured path is what users get.
  const measurable = measureSongNameWidthPx("TEST") !== null;

  it("never goes below the baseline width", () => {
    expect(autoColumnWidthRem("Intro")).toBeGreaterThanOrEqual(
      baselineColumnWidthRem(),
    );
    expect(autoColumnWidthRem("")).toBeGreaterThanOrEqual(
      baselineColumnWidthRem(),
    );
  });

  it("puts a short title exactly at the baseline", () => {
    // "Intro" is shorter than "Song 1" + badges, so it must not force the
    // column any wider than the baseline every new song starts at.
    expect(autoColumnWidthRem("Intro")).toBe(baselineColumnWidthRem());
  });

  it("never exceeds the maximum, however long the title", () => {
    expect(autoColumnWidthRem("x".repeat(500))).toBeLessThanOrEqual(
      COMPACT_COLUMN_MAX_WIDTH_REM,
    );
  });

  it("falls back to the fixed default when text cannot be measured", () => {
    if (measurable) return;
    expect(autoColumnWidthRem("x".repeat(80))).toBe(
      COMPACT_COLUMN_DEFAULT_WIDTH_REM,
    );
    expect(baselineColumnWidthRem()).toBe(COMPACT_COLUMN_DEFAULT_WIDTH_REM);
  });

  it("widens for a longer title, and reserves room for badges", () => {
    if (!measurable) return;
    const short = autoColumnWidthRem("Intro");
    const long = autoColumnWidthRem("Cancion con un nombre larguisimo");
    expect(long).toBeGreaterThan(short);
    expect(
      autoColumnWidthRem("Cancion con un nombre larguisimo", {
        hasBadges: true,
      }),
    ).toBeGreaterThan(long);
  });
});

describe("baselineColumnWidthRem", () => {
  const measurable = measureSongNameWidthPx("TEST") !== null;

  it("fits the default song name with every badge showing", () => {
    if (!measurable) return;
    // The whole point of the baseline: a freshly created "Song 1" must never
    // need to ellipsize, badges and all.
    expect(autoColumnWidthRem("Song 1", { hasBadges: true })).toBe(
      baselineColumnWidthRem(),
    );
  });

  it("stays within the draggable range", () => {
    const baseline = baselineColumnWidthRem();
    expect(baseline).toBeGreaterThanOrEqual(COMPACT_COLUMN_MIN_WIDTH_REM);
    expect(baseline).toBeLessThanOrEqual(COMPACT_COLUMN_MAX_WIDTH_REM);
  });

  it("is the hard floor for every width the UI can produce", () => {
    // Whatever a drag computes, the clamp must never return less than this.
    const baseline = baselineColumnWidthRem();
    for (const attempted of [-100, 0, 1, 5, 7.5, 9, baseline - 0.01]) {
      expect(clampColumnWidthRem(attempted)).toBeGreaterThanOrEqual(baseline);
    }
  });

  it("leaves room for the localized name too", () => {
    if (!measurable) return;
    // The baseline is built from the English "Song 1" on purpose, but the
    // Spanish default is longer — it is allowed to widen its own column, and
    // must not silently truncate at the baseline.
    expect(
      autoColumnWidthRem("Canción 1", { hasBadges: true }),
    ).toBeGreaterThanOrEqual(baselineColumnWidthRem());
  });
});

describe("columnDensityClass", () => {
  it("keeps every badge at a comfortable width", () => {
    expect(columnDensityClass(14)).toBe("");
    expect(columnDensityClass(COMPACT_COLUMN_NARROW_WIDTH_REM + 0.5)).toBe("");
  });

  it("drops the bpm badge once the column is narrow", () => {
    expect(columnDensityClass(COMPACT_COLUMN_NARROW_WIDTH_REM)).toBe(
      "is-narrow",
    );
    expect(columnDensityClass(8)).toBe("is-narrow");
  });

  it("drops the key badge too at the narrowest widths", () => {
    expect(columnDensityClass(COMPACT_COLUMN_VERY_NARROW_WIDTH_REM)).toBe(
      "is-narrow is-very-narrow",
    );
    expect(columnDensityClass(COMPACT_COLUMN_MIN_WIDTH_REM)).toBe(
      "is-narrow is-very-narrow",
    );
  });

  it("escalates monotonically as the column narrows", () => {
    // The very-narrow state must always imply the narrow one, or the key
    // badge could outlive the bpm badge and the header would read oddly.
    for (let width = COMPACT_COLUMN_MIN_WIDTH_REM; width <= 20; width += 0.5) {
      const cls = columnDensityClass(width);
      if (cls.includes("is-very-narrow")) {
        expect(cls).toContain("is-narrow");
      }
    }
  });
});
