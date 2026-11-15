import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JUMP_LANDING_GRACE_MS, usePerformanceHistory } from "./usePerformanceHistory";

type Props = { marker: string | null; line: number | null; pending: string | null; region?: string };

function setup(initial: Props) {
  const hook = renderHook((props: Props) => usePerformanceHistory(props.region ?? "song", props.marker, props.line, props.pending), {
    initialProps: initial,
  });
  const played = () => hook.result.current.history.map((entry) => entry.markerId);
  return { ...hook, played };
}

describe("usePerformanceHistory", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ignores the part the visual clock overshoots into while a jump is scheduled", () => {
    const { rerender, played, result } = setup({ marker: "intro", line: 0, pending: null });
    rerender({ marker: "intro", line: 0, pending: "chorus2" });
    expect(result.current.pendingMarkerId).toBe("chorus2");
    // The engine jumped at the end of the intro; the UI clock plays on into verse 1.
    rerender({ marker: "verse1", line: 0, pending: "chorus2" });
    expect(played()).toEqual(["intro"]);
    // The snapshot arrives: playhead in the target, nothing pending.
    rerender({ marker: "chorus2", line: 0, pending: null });
    expect(played()).toEqual(["intro", "chorus2"]);
    expect(result.current.pendingMarkerId).toBeNull();
  });

  it("keeps previewing the target when the pending jump clears a tick before the playhead lands", () => {
    const { rerender, played, result } = setup({ marker: "intro", line: 0, pending: "chorus2" });
    rerender({ marker: "verse1", line: 0, pending: null });
    expect(result.current.pendingMarkerId).toBe("chorus2");
    expect(played()).toEqual(["intro"]);
    rerender({ marker: "chorus2", line: 0, pending: null });
    expect(played()).toEqual(["intro", "chorus2"]);
  });

  it("a jump to the part playing plays it again below", () => {
    const { rerender, played } = setup({ marker: "chorus", line: 3, pending: null });
    rerender({ marker: "chorus", line: 3, pending: "chorus" });
    rerender({ marker: "outro", line: 0, pending: "chorus" });
    rerender({ marker: "chorus", line: 0, pending: null });
    expect(played()).toEqual(["chorus", "chorus"]);
    expect(new Set(played().map((_, index) => index)).size).toBe(2);
  });

  it("a vamp looping inside the part plays it again below, never back up", () => {
    const { rerender, played } = setup({ marker: "bridge", line: 1, pending: null });
    rerender({ marker: "bridge", line: 2, pending: null });
    rerender({ marker: "bridge", line: 1, pending: null });
    expect(played()).toEqual(["bridge", "bridge"]);
    rerender({ marker: "bridge", line: 2, pending: null });
    expect(played()).toEqual(["bridge", "bridge"]);
  });

  it("a jump that vanishes without landing is given up after the grace", () => {
    const { rerender, played, result } = setup({ marker: "intro", line: 0, pending: "chorus2" });
    rerender({ marker: "intro", line: 1, pending: null });
    expect(result.current.pendingMarkerId).toBe("chorus2");
    act(() => {
      vi.advanceTimersByTime(JUMP_LANDING_GRACE_MS + 50);
    });
    expect(result.current.pendingMarkerId).toBeNull();
    rerender({ marker: "verse1", line: 0, pending: null });
    expect(played()).toEqual(["intro", "verse1"]);
  });

  it("starts over in another song", () => {
    const { rerender, played } = setup({ marker: "intro", line: 0, pending: null });
    rerender({ marker: "verse1", line: 0, pending: null });
    rerender({ marker: "a", line: 0, pending: null, region: "other" });
    expect(played()).toEqual(["a"]);
  });
});
