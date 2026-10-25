import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { testRegion, testSetlistProps } from "./testBindings";

const flags = vi.hoisted(() => ({ lyrics: true }));
vi.mock("@libretracks/shared/featureFlags", async (importOriginal) => {
  const original = await importOriginal<typeof import("@libretracks/shared/featureFlags")>();
  return {
    ...original,
    FEATURE_FLAGS: new Proxy(original.FEATURE_FLAGS, {
      get: (target, key) => (key === "lyrics" ? flags.lyrics : Reflect.get(target, key)),
    }),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));
vi.mock("../tracks/TrackMeter", () => ({ SongMasterMeter: () => null, TrackMeter: () => null }));
vi.mock("../structure/ArrangementBadge", () => ({ ArrangementBadge: () => null }));
// Live's panel itself is tested in charts/; here: what Setlist hands it.
const panel = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock("../charts/LiveChartPanel", () => ({
  LiveChartPanel: (props: Record<string, unknown>) => {
    panel.props.push(props);
    const region = props.region as { name: string } | null;
    return <div data-testid="chart-panel">{region?.name}</div>;
  },
}));

const regions = [
  testRegion("a", { name: "Alfa", startSeconds: 0, endSeconds: 60, chart: { text: "[C]Alfa", links: [] } }),
  testRegion("b", { name: "Beta", startSeconds: 60, endSeconds: 120, chart: { text: "[G]Beta", links: [] } }),
];

function props(overrides: Record<string, unknown> = {}) {
  const base = testSetlistProps({ regions } as Partial<SongView>);
  return {
    ...base,
    selectedRegionId: "b",
    performance: { ...base.performance, onChartChange: vi.fn(async () => {}) },
    ...overrides,
  };
}

const lyricsButton = () => screen.queryByRole("button", { name: /setlistView.lyrics.button/ });
const zones = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-setlist-zone]")).map((zone) => zone.dataset.setlistZone);

beforeEach(() => {
  flags.lyrics = true;
  panel.props.length = 0;
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
});

describe("Setlist lyrics", () => {
  // C1 + C2: the selected song, and Live's onChartChange (one definition).
  it("shows the selected song's chart with Live's onChartChange, and follows the selection", () => {
    const base = props();
    const { rerender } = render(<SetlistView {...base} layoutClass="wide" />);
    fireEvent.click(lyricsButton()!);
    expect(screen.getByTestId("chart-panel").textContent).toBe("Beta");
    const last = panel.props.at(-1)!;
    expect(last.onChartChange).toBe(base.performance.onChartChange);
    expect(last.positionSecondsRef).toBe(base.performance.positionSecondsRef);
    rerender(<SetlistView {...base} selectedRegionId="a" layoutClass="wide" />);
    expect(screen.getByTestId("chart-panel").textContent).toBe("Alfa");
  });

  // C3
  it("with the lyrics flag off there is no button and no Edit tab", () => {
    flags.lyrics = false;
    render(<SetlistView {...props()} layoutClass="wide" />);
    expect(lyricsButton()).toBeNull();
    act(() => useSetlistStore.getState().setEditMode("song"));
    expect(screen.queryByRole("tab", { name: "setlistView.edit.modes.lyrics" })).toBeNull();
  });

  // C5: column beside the band, instead of the band, a pane on the phone.
  it("wide: a column beside the band, the console stays", () => {
    const { container } = render(<SetlistView {...props()} layoutClass="wide" />);
    fireEvent.click(lyricsButton()!);
    expect(container.querySelector(".lt-setlist-band-row [data-setlist-zone='overview']")).not.toBeNull();
    expect(container.querySelector(".lt-setlist-band-row [data-setlist-zone='lyrics']")).not.toBeNull();
    expect(zones(container)).toContain("mixer");
  });

  it("medium: the lyrics take the band's place; the button brings the band back", () => {
    const { container } = render(<SetlistView {...props()} layoutClass="medium" />);
    fireEvent.click(lyricsButton()!);
    expect(zones(container)).toEqual(["songs", "lyrics", "mixer"]);
    fireEvent.click(lyricsButton()!);
    expect(zones(container)).toEqual(["songs", "overview", "mixer"]);
  });

  it("short: one more pane under the songs, and closing goes back to the mixer", () => {
    const { container } = render(<SetlistView {...props()} layoutClass="short" />);
    fireEvent.click(lyricsButton()!);
    expect(zones(container)).toEqual(["songs", "lyrics"]);
    act(() => (panel.props.at(-1)!.onClose as () => void)());
    expect(zones(container)).toEqual(["songs", "mixer"]);
  });

  it("Edit → Lyrics opens the panel with the editor showing", () => {
    render(<SetlistView {...props()} layoutClass="wide" />);
    act(() => useSetlistStore.getState().setEditMode("lyrics"));
    expect(panel.props.at(-1)!.startEditing).toBe(true);
    expect(screen.getByTestId("chart-panel").textContent).toBe("Beta");
  });
});
