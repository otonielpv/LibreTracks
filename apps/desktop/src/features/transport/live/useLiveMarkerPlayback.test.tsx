import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary } from "@libretracks/shared/models";
import { buildLiveMarkerGroups } from "./liveMarkerModel";
import { useLiveMarkerPlayback } from "./useLiveMarkerPlayback";

describe("useLiveMarkerPlayback", () => {
  afterEach(() => vi.useRealTimers());

  it("follows the mutable playhead and advances the visible marker", () => {
    vi.useFakeTimers();
    const markers: SectionMarkerSummary[] = [
      { id: "intro", name: "Intro", startSeconds: 0, kind: "intro" },
      { id: "verse", name: "Estrofa", startSeconds: 10, kind: "verse" },
      { id: "chorus", name: "Estribillo", startSeconds: 20, kind: "chorus" },
    ];
    const groups = buildLiveMarkerGroups(markers);
    const playhead = { current: 5 };
    const { result } = renderHook(() =>
      useLiveMarkerPlayback(groups, [], playhead),
    );

    expect(result.current.activeGroupId).toBe("intro");
    expect(result.current.nextGroupId).toBe("verse");

    playhead.current = 12;
    act(() => vi.advanceTimersByTime(100));

    expect(result.current.activeGroupId).toBe("verse");
    expect(result.current.nextGroupId).toBe("chorus");
  });

  it("publishes a marker boundary on the next frame without rounding early", () => {
    vi.useFakeTimers();
    const groups = buildLiveMarkerGroups([
      { id: "intro", name: "Intro", startSeconds: 0, kind: "intro" },
      { id: "verse", name: "Estrofa", startSeconds: 10, kind: "verse" },
    ]);
    const playhead = { current: 9.6 };
    const { result } = renderHook(() =>
      useLiveMarkerPlayback(groups, [], playhead),
    );

    expect(result.current.activeGroupId).toBe("intro");
    expect(result.current.positionSeconds).toBe(9.6);

    playhead.current = 10.01;
    act(() => vi.advanceTimersToNextFrame());

    expect(result.current.activeGroupId).toBe("verse");
    expect(result.current.positionSeconds).toBe(10.01);
  });
});
