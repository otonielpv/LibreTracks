import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listSystemFonts = vi.fn(async () => ["Comic Neue", "Fira Sans", "Segoe Print"]);
vi.mock("../desktopApi", () => ({ listSystemFonts: () => listSystemFonts() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChartStyleMenu, resetSystemFontsCache, useChartStyleStore } from "./ChartStyleMenu";
import { DEFAULT_CHART_STYLE } from "./chartStyle";

describe("ChartStyleMenu", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSystemFontsCache();
    listSystemFonts.mockClear();
    useChartStyleStore.setState({ style: DEFAULT_CHART_STYLE });
  });

  it("picks a font installed on this device for the lyrics, searching by name", async () => {
    render(<ChartStyleMenu />);
    fireEvent.click(screen.getByRole("button", { name: "chartStyle.title" }));
    expect(listSystemFonts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "chartStyle.lyricFont: chartStyle.systemFonts" }));
    const list = await screen.findByRole("listbox", { name: "chartStyle.lyricFont: chartStyle.systemFonts" });
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    fireEvent.change(screen.getByRole("searchbox", { name: "chartStyle.searchFonts" }), { target: { value: "fira" } });
    const option = within(list).getByRole("button", { name: "Fira Sans" });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(option);
    expect(useChartStyleStore.getState().style.lyricFont).toBe("family:Fira Sans");
    expect(useChartStyleStore.getState().style.chordFont).toBe("inter");
    expect(JSON.parse(window.localStorage.getItem("lt.liveChart.style")!).lyricFont).toBe("family:Fira Sans");
    // The button now names the chosen font; the built-in segments are not lit.
    expect(screen.getByRole("button", { name: "chartStyle.lyricFont: chartStyle.systemFonts" }).textContent).toContain("Fira Sans");
    const builtins = screen.getByRole("radiogroup", { name: "chartStyle.lyricFont" });
    expect(within(builtins).queryByRole("radio", { checked: true })).toBeNull();
  });

  it("says so when the device lists no fonts", async () => {
    listSystemFonts.mockResolvedValueOnce([]);
    render(<ChartStyleMenu />);
    fireEvent.click(screen.getByRole("button", { name: "chartStyle.title" }));
    fireEvent.click(screen.getByRole("button", { name: "chartStyle.chordFont: chartStyle.systemFonts" }));
    expect(await screen.findByText("chartStyle.noSystemFonts")).toBeTruthy();
  });
});
