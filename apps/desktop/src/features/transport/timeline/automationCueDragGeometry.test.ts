import { describe, expect, it } from "vitest";

import { screenXToSeconds, secondsToScreenX } from "./timelineMath";

/**
 * Geometry behind the automation-cue drag.
 *
 * Cue diamonds are painted by the canvas at `secondsToScreenX(atSeconds,
 * cameraX, livePixelsPerSecond)`, but their invisible hit target used to be
 * placed at `atSeconds * pixelsPerSecond` — no camera term, and the committed
 * (not live) zoom. The two agree only at cameraX = 0 with a settled zoom, so
 * once the timeline was scrolled or zoomed the hotspot drifted off the diamond
 * and the cue could not be grabbed at all. These tests pin the invariant that
 * both must be computed the same way.
 *
 * Ruler markers (section/tempo) never had this bug: they live inside the ruler
 * overlay, which CanvasTimeline transforms with translateX(-cameraX), so the
 * camera is applied for them by the wrapper.
 */
describe("automation cue screen placement", () => {
  it("shifts with the camera", () => {
    // Same cue, timeline scrolled right: the diamond must move left on screen.
    expect(secondsToScreenX(10, 0, 30)).toBe(300);
    expect(secondsToScreenX(10, 120, 30)).toBe(180);
  });

  it("drifts from the naive placement once scrolled or zoomed", () => {
    // The old hotspot formula, for reference.
    const naiveLeft = (atSeconds: number, pixelsPerSecond: number) =>
      atSeconds * pixelsPerSecond;

    // Agrees only at the origin with a settled zoom.
    expect(secondsToScreenX(10, 0, 30)).toBe(naiveLeft(10, 30));

    // Scrolled: off by exactly the camera.
    expect(secondsToScreenX(10, 250, 30)).not.toBe(naiveLeft(10, 30));
    expect(naiveLeft(10, 30) - secondsToScreenX(10, 250, 30)).toBe(250);

    // Zoomed (live 120 vs committed 30): off by the zoom difference.
    expect(secondsToScreenX(10, 0, 120)).not.toBe(naiveLeft(10, 30));
  });

  it("round-trips a stationary pointer back to the cue's own position", () => {
    // beginMarkerMove seeds pointerStartLocalX from the cue's seconds, so a
    // drag that hasn't moved must resolve to exactly initialStartSeconds at any
    // camera/zoom — otherwise merely pressing a cue would nudge it.
    for (const cameraX of [0, 137, 4021.5]) {
      for (const pixelsPerSecond of [4, 30, 120, 800]) {
        const atSeconds = 12.75;
        const localX = secondsToScreenX(atSeconds, cameraX, pixelsPerSecond);
        expect(
          screenXToSeconds(localX, cameraX, pixelsPerSecond),
        ).toBeCloseTo(atSeconds, 9);
      }
    }
  });

  it("moves the cue by the pointer delta, independent of camera and zoom", () => {
    // Dragging 60 px right at 30 px/s is +2 s wherever the camera happens to be.
    for (const cameraX of [0, 500, 9000]) {
      const atSeconds = 8;
      const pixelsPerSecond = 30;
      const startLocalX = secondsToScreenX(atSeconds, cameraX, pixelsPerSecond);
      const next = screenXToSeconds(
        startLocalX + 60,
        cameraX,
        pixelsPerSecond,
      );
      expect(next - atSeconds).toBeCloseTo(2);
    }
  });

  it("follows a camera that pans mid-drag", () => {
    // Auto-scroll moves the camera while the pointer is held still. Because the
    // drag re-reads cameraX each move, the cue follows the timeline under the
    // cursor instead of sticking to a stale delta.
    const atSeconds = 8;
    const pixelsPerSecond = 30;
    const startLocalX = secondsToScreenX(atSeconds, 0, pixelsPerSecond);

    // Pointer unmoved, camera panned right by 90 px = 3 s.
    const next = screenXToSeconds(startLocalX, 90, pixelsPerSecond);
    expect(next - atSeconds).toBeCloseTo(3);
  });
});
