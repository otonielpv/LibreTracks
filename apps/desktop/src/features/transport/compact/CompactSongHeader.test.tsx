import { fireEvent, render, screen } from "@testing-library/react";
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

  it("el selector de nota tiene atras y vuelve al menu raiz", () => {
    const { container } = render(renderHeader(false));
    fireEvent.contextMenu(container.firstElementChild!);
    fireEvent.click(screen.getByText("Nota de la canción ▸"));
    expect(screen.getByText(/Sin nota/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(screen.queryByText(/Sin nota/)).toBeNull();
    expect(screen.getByText("Renombrar canción")).toBeTruthy();
  });

  it("shows the reorder grip only when reordering is wired", () => {
    const onKeyDown = vi.fn();
    const { rerender } = render(renderHeader(false));
    expect(screen.queryByRole("button", { name: "liveView.reorderSong" })).toBeNull();

    rerender(
      <CompactSongHeaderComponent
        {...renderHeader(false).props}
        reorderHandleProps={{
          onPointerDown: vi.fn(),
          onClick: vi.fn(),
          onKeyDown,
        }}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "liveView.reorderSong" }), {
      key: "ArrowRight",
    });
    expect(onKeyDown).toHaveBeenCalled();
  });
});
