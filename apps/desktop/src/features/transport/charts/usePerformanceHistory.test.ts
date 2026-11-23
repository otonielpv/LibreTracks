import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JUMP_LANDING_GRACE_MS, usePerformanceHistory } from "./usePerformanceHistory";

type Props = { marker: string | null; line: number | null; pending: string | null; region?: string; vamp?: string | null; pass?: number };

function setup(initial: Props) {
  const hook = renderHook((props: Props) => usePerformanceHistory(props.region ?? "song", props.marker, props.line, props.pending, props.vamp ?? null, null, null, props.pass ?? 0), {
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

  it("the second pass of a chorus sung twice in its marker is not going back", () => {
    const { rerender, played } = setup({ marker: "chorus", line: 3, pending: null, pass: 0 });
    rerender({ marker: "chorus", line: 0, pending: null, pass: 1 });
    expect(played()).toEqual(["chorus"]);
    // A seek back inside the same pass still is.
    rerender({ marker: "chorus", line: 2, pending: null, pass: 1 });
    rerender({ marker: "chorus", line: 0, pending: null, pass: 1 });
    expect(played()).toEqual(["chorus", "chorus"]);
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

  it("vamping the whole part: the overshoot into the next part is ignored, the loop plays again below", () => {
    const { rerender, played } = setup({ marker: "verse2", line: 2, pending: null, vamp: "verse2" });
    rerender({ marker: "verse2", line: 3, pending: null, vamp: "verse2" });
    // End of the loop: the UI clock plays on into the chorus for a moment.
    rerender({ marker: "chorus", line: 0, pending: null, vamp: "verse2" });
    expect(played()).toEqual(["verse2"]);
    rerender({ marker: "verse2", line: 0, pending: null, vamp: "verse2" });
    expect(played()).toEqual(["verse2", "verse2"]);
    // The vamp released: the chorus that plays now is real.
    rerender({ marker: "chorus", line: 0, pending: null, vamp: null });
    expect(played()).toEqual(["verse2", "verse2", "chorus"]);
  });

  it("a jump that disappears before it fires was cancelled: the preview goes at once", () => {
    const position = { current: 10 };
    const hook = renderHook(
      (props: { marker: string; pending: string | null }) =>
        usePerformanceHistory("song", props.marker, 0, props.pending, null, 16, position),
      { initialProps: { marker: "intro", pending: "chorus2" as string | null } },
    );
    expect(hook.result.current.pendingMarkerId).toBe("chorus2");
    hook.rerender({ marker: "intro", pending: null });
    expect(hook.result.current.pendingMarkerId).toBeNull();
    // What plays from now on is real again.
    position.current = 16.2;
    hook.rerender({ marker: "verse1", pending: null });
    expect(hook.result.current.history.map((entry) => entry.markerId)).toEqual(["intro", "verse1"]);
  });

  it("a jump that disappears after it fired is landing: the preview waits for the playhead", () => {
    const position = { current: 16.3 };
    const hook = renderHook(
      (props: { marker: string; pending: string | null }) =>
        usePerformanceHistory("song", props.marker, 0, props.pending, null, 16, position),
      { initialProps: { marker: "intro", pending: "chorus2" as string | null } },
    );
    hook.rerender({ marker: "verse1", pending: null });
    expect(hook.result.current.pendingMarkerId).toBe("chorus2");
    hook.rerender({ marker: "chorus2", pending: null });
    expect(hook.result.current.history.map((entry) => entry.markerId)).toEqual(["intro", "chorus2"]);
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
