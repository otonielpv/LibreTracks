import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  type SongView,
  type TransportSnapshot,
} from "@libretracks/shared/models";

import { useTimelineActions } from "./useTimelineActions";

const scheduleRegionJump = vi.fn();

vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...actual,
    scheduleRegionJump: (id: string) => scheduleRegionJump(id),
  };
});

const song = {
  regions: [
    { id: "a", name: "A", startSeconds: 0, endSeconds: 100 },
    { id: "b", name: "B", startSeconds: 100, endSeconds: 200 },
  ],
} as unknown as SongView;

function setup(reveal: (seconds: number) => void) {
  return renderHook(() =>
    useTimelineActions({
      appSettings: { ...DEFAULT_APP_SETTINGS, songJumpTrigger: "immediate" },
      song,
      snapshotRef: { current: { positionSeconds: 10 } as TransportSnapshot },
      displayPositionSecondsRef: { current: 10 },
      selectedRegionId: null,
      setSelectedRegionId: () => {},
      applyPlaybackSnapshot: () => {},
      setStatus: () => {},
      t: (key) => key,
      handleSelectedRegionTransposeChange: () => {},
      revealPlayheadAfterStoppedJump: reveal,
    }),
  ).result.current;
}

describe("song navigation and playhead follow", () => {
  beforeEach(() => scheduleRegionJump.mockReset());

  it("reveals the playhead after next song while stopped", async () => {
    scheduleRegionJump.mockResolvedValue({ playbackState: "stopped", positionSeconds: 100 });
    const reveal = vi.fn();
    await setup(reveal).handleNextSongClick();
    expect(scheduleRegionJump).toHaveBeenCalledWith("b");
    expect(reveal).toHaveBeenCalledWith(100);
  });

  it("leaves it to the playback loop while playing", async () => {
    scheduleRegionJump.mockResolvedValue({ playbackState: "playing", positionSeconds: 100 });
    const reveal = vi.fn();
    await setup(reveal).handleNextSongClick();
    expect(reveal).not.toHaveBeenCalled();
  });
});
