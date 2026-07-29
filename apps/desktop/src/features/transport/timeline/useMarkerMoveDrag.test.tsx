import { createRef, type MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import type { SongView } from "@libretracks/shared/models";
import { LANE_CUES, LANE_SECTIONS } from "../Renderer/drawBackground";
import { useMarkerMoveDrag } from "./useMarkerMoveDrag";

/**
 * End-to-end drag through the real hook, driven with pointer events.
 *
 * These exist because the unit-level pieces (lane hit-testing, the commit
 * handler) can each be correct while the value is dropped BETWEEN them: a
 * callback prop typed with fewer parameters silently discards the extra
 * argument and TypeScript accepts it, so the marker moves on screen and the
 * engine never hears about the lane change. Only exercising the whole hook
 * catches that.
 */

const SONG = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  sectionMarkers: [
    { id: "m1", name: "Bridge", startSeconds: 4, kind: "bridge" },
  ],
} as unknown as SongView;

function laneCentre(lane: { top: number; height: number }) {
  return lane.top + lane.height / 2;
}

function setup(onMarkerMoveCommit: ReturnType<typeof vi.fn>) {
  const cameraXRef = createRef<number>() as MutableRefObject<number>;
  cameraXRef.current = 0;
  const ppsRef = createRef<number>() as MutableRefObject<number>;
  ppsRef.current = 100;

  const api: { current: ReturnType<typeof useMarkerMoveDrag> | null } = {
    current: null,
  };

  function Harness() {
    const drag = useMarkerMoveDrag({
      song: SONG,
      snapEnabled: false,
      cameraXRef,
      livePixelsPerSecondRef: ppsRef,
      pixelsPerSecond: 100,
      onMarkerMoveCommit,
    });
    api.current = drag;
    return (
      <button
        type="button"
        data-testid="hotspot"
        onPointerDown={(event) => drag.beginMarkerMove(event, "m1", 4)}
        onPointerMove={drag.updateMarkerMove}
        onPointerUp={drag.endMarkerMove}
      />
    );
  }

  const view = render(<Harness />);
  const hotspot = view.getByTestId("hotspot");
  // The hotspot is positioned at its lane's top; give it a real rect so the
  // hook can turn clientY into a ruler-relative offset.
  hotspot.getBoundingClientRect = () =>
    ({ top: LANE_SECTIONS.top, left: 0, width: 68, height: 26 }) as DOMRect;
  Object.defineProperty(hotspot, "offsetWidth", { value: 68 });
  hotspot.setPointerCapture = () => {};
  hotspot.releasePointerCapture = () => {};
  return { hotspot };
}

/**
 * jsdom has no PointerEvent, and a plain fireEvent init drops `pointerId` on
 * the way to React's synthetic event — which the hook uses to pair up a drag's
 * down/move/up. Build a MouseEvent and attach the pointer fields by hand so
 * they survive.
 */
function pointer(type: string, clientX: number, clientY: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

/** Press on the section lane, travel to `toY`, release. */
function dragTo(hotspot: HTMLElement, toY: number, toX = 0) {
  const startY = laneCentre(LANE_SECTIONS);
  fireEvent(hotspot, pointer("pointerdown", 0, startY));
  fireEvent(hotspot, pointer("pointermove", toX, toY));
  fireEvent(hotspot, pointer("pointerup", toX, toY));
}

describe("useMarkerMoveDrag lane changes", () => {
  it("commits the new category when dropped on the cue lane", () => {
    // The reported bug: a Bridge dragged into the cue row kept announcing with
    // a count-in, because the category never reached the commit.
    const onMarkerMoveCommit = vi.fn();
    const { hotspot } = setup(onMarkerMoveCommit);

    // The grab starts at the section lane's centre; travel up by the distance
    // between the two lane centres to land in the cue lane.
    const travel = laneCentre(LANE_SECTIONS) - laneCentre(LANE_CUES);
    dragTo(hotspot, laneCentre(LANE_SECTIONS) - travel);

    expect(onMarkerMoveCommit).toHaveBeenCalledTimes(1);
    expect(onMarkerMoveCommit.mock.calls[0][2]).toBe("cue");
  });

  it("omits the category on a purely horizontal move", () => {
    // A plain nudge must not write an override the user never asked for.
    const onMarkerMoveCommit = vi.fn();
    const { hotspot } = setup(onMarkerMoveCommit);

    dragTo(hotspot, laneCentre(LANE_SECTIONS), 50);

    expect(onMarkerMoveCommit).toHaveBeenCalledTimes(1);
    expect(onMarkerMoveCommit.mock.calls[0][2]).toBeUndefined();
  });
});
