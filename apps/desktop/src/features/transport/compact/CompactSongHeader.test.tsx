import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SongRegionSummary } from "@libretracks/shared/models";
import { CompactSongHeaderComponent } from "./CompactSongHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "liveView.queued" ? "En cola" : key),
  }),
}));

const region: SongRegionSummary = {
  id: "second",
  name: "Segunda",
  startSeconds: 40,
  endSeconds: 80,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
};

const renderHeader = (isQueued: boolean) => (
  <CompactSongHeaderComponent
    region={region}
    isActive={false}
    isQueued={isQueued}
    bpm={120}
    onMasterGainChange={vi.fn()}
    onMasterGainCommit={vi.fn()}
    onPlay={vi.fn()}
    onRename={vi.fn()}
    onSetBpm={vi.fn()}
    onDelete={vi.fn()}
    onExport={vi.fn()}
    onSetKey={vi.fn()}
    isSelected={false}
    onSelect={vi.fn()}
  />
);

describe("CompactSongHeader", () => {
  it("identifies the destination of an armed song jump", () => {
    const { container, rerender } = render(renderHeader(true));

    expect(container.firstElementChild?.classList.contains("is-queued")).toBe(true);
    expect(screen.getByText("En cola")).toBeTruthy();

    rerender(renderHeader(false));

    expect(container.firstElementChild?.classList.contains("is-queued")).toBe(false);
    expect(screen.queryByText("En cola")).toBeNull();
  });
});
