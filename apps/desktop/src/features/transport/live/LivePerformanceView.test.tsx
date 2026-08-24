import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";
import { LivePerformanceView } from "./LivePerformanceView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string; time?: string; count?: number }) => {
      const messages: Record<string, string> = {
        "liveView.title": "Live View",
        "liveView.selectSong": `Show markers for ${values?.name}`,
        "liveView.playSong": `Play ${values?.name}`,
        "liveView.songProgress": "Current song progress",
      };
      return messages[key] ?? key;
    },
  }),
}));

const region = (
  id: string,
  name: string,
  startSeconds: number,
  endSeconds: number,
): SongRegionSummary => ({
  id,
  name,
  startSeconds,
  endSeconds,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
});

const song: SongView = {
  id: "session",
  title: "Directo",
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 80,
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [
    region("first", "Primera", 0, 40),
    region("second", "Segunda", 40, 80),
  ],
  sectionMarkers: [
    { id: "verse", name: "Estrofa", startSeconds: 10, kind: "verse" },
    { id: "chorus", name: "Estribillo", startSeconds: 50, kind: "chorus" },
  ],
  clips: [],
  tracks: [],
  projectRevision: 1,
};

describe("LivePerformanceView", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("filters markers by selection and keeps song playback on a separate button", () => {
    const onSongAction = vi.fn();
    const renderView = (
      pendingMarkerId: string | null = null,
      pendingMarkerName: string | null = null,
    ) => (
      <LivePerformanceView
        song={song}
        positionSecondsRef={{ current: 10 }}
        settings={DEFAULT_APP_SETTINGS}
        pendingMarkerId={pendingMarkerId}
        pendingMarkerName={pendingMarkerName}
        activeVamp={null}
        onViewModeChange={vi.fn()}
        onMarkerAction={vi.fn()}
        onSongAction={onSongAction}
        onToggleVamp={vi.fn()}
        onCancelPendingJump={vi.fn()}
        onGlobalJumpModeChange={vi.fn()}
        onGlobalJumpBarsChange={vi.fn()}
        onSongJumpTriggerChange={vi.fn()}
        onSongJumpBarsChange={vi.fn()}
        onSongTransitionModeChange={vi.fn()}
        onVampModeChange={vi.fn()}
        onVampBarsChange={vi.fn()}
      />
    );
    const { container, rerender } = render(renderView());

    expect(screen.getByText("Estrofa")).toBeTruthy();
    expect(container.querySelector(".lt-live-execution")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "liveView.cancelJump" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByText("Estribillo")).toBeNull();
    expect(
      screen.getByRole("progressbar", { name: "Current song progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("25");

    fireEvent.click(screen.getByRole("button", { name: "Show markers for Segunda" }));
    expect(screen.queryByText("Estrofa")).toBeNull();
    expect(screen.getByText("Estribillo")).toBeTruthy();
    expect(onSongAction).not.toHaveBeenCalled();
    expect(container.querySelector(".lt-live-cue-progress")).toBeTruthy();
    expect(container.querySelector(".lt-live-cue-progress.is-active")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Play Segunda" }));
    expect(onSongAction).toHaveBeenCalledWith(song.regions[1]);

    rerender(renderView("second", "Segunda"));

    const queuedSong = container.querySelector(".lt-live-region-row.is-queued");
    expect(queuedSong?.textContent).toContain("Segunda");
    expect(queuedSong?.textContent).toContain("liveView.queued");
    expect(
      (screen.getByRole("button", { name: "liveView.cancelJump" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("exposes the song transition and identifies the marker repeated by VAMP", () => {
    const onSongTransitionModeChange = vi.fn();
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      songTransitionMode: "fade_out" as const,
      vampMode: "bars" as const,
      vampBars: 4,
    };

    const { container } = render(
      <LivePerformanceView
        song={song}
        positionSecondsRef={{ current: 10 }}
        settings={settings}
        pendingMarkerId={null}
        pendingMarkerName={null}
        activeVamp={{ startSeconds: 10, endSeconds: 18 }}
        onViewModeChange={vi.fn()}
        onMarkerAction={vi.fn()}
        onSongAction={vi.fn()}
        onToggleVamp={vi.fn()}
        onCancelPendingJump={vi.fn()}
        onGlobalJumpModeChange={vi.fn()}
        onGlobalJumpBarsChange={vi.fn()}
        onSongJumpTriggerChange={vi.fn()}
        onSongJumpBarsChange={vi.fn()}
        onSongTransitionModeChange={onSongTransitionModeChange}
        onVampModeChange={vi.fn()}
        onVampBarsChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "liveView.fadeOut" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "liveView.cleanCut" }));
    expect(onSongTransitionModeChange).toHaveBeenCalledWith("instant");
    expect(container.querySelector(".lt-live-cue-row.is-vamp")?.textContent)
      .toContain("liveView.vampBarsBadge");
  });
});
