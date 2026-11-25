import { describe, expect, it } from "vitest";

import { chartStyleVars, DEFAULT_CHART_STYLE, isDefaultChartStyle, parseChartStyle } from "./chartStyle";

describe("chartStyle", () => {
  it("reads the stored style leniently: bad fields keep their default", () => {
    expect(parseChartStyle(null)).toEqual(DEFAULT_CHART_STYLE);
    expect(parseChartStyle("not json")).toEqual(DEFAULT_CHART_STYLE);
    expect(parseChartStyle('{"lyricFont":"comic","chordFont":"mono","chordColor":"red","chordBold":false}')).toEqual({
      ...DEFAULT_CHART_STYLE,
      chordFont: "mono",
      chordBold: false,
    });
    expect(parseChartStyle('{"chordColor":"#5C9DFF"}').chordColor).toBe("#5c9dff");
    expect(parseChartStyle('{"chordColor":"accent"}').chordColor).toBe("accent");
  });

  it("the default style sets no variables, so the themed stylesheet applies", () => {
    expect(chartStyleVars(DEFAULT_CHART_STYLE)).toEqual({});
    expect(isDefaultChartStyle(DEFAULT_CHART_STYLE)).toBe(true);
  });

  it("maps each choice to the variables the stylesheet reads", () => {
    expect(
      chartStyleVars({ lyricFont: "serif", chordFont: "mono", chordColor: "accent", chordBold: false }),
    ).toMatchObject({
      "--lt-chart-lyric-font": expect.stringContaining("serif"),
      "--lt-chart-chord-font": expect.stringContaining("monospace"),
      "--lt-chart-chord-color": "var(--lt-accent)",
      "--lt-chart-chord-weight": "500",
    });
    expect(chartStyleVars({ ...DEFAULT_CHART_STYLE, chordColor: "#ff5c5c" })).toEqual({ "--lt-chart-chord-color": "#ff5c5c" });
  });
});
