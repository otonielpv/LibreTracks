import { createRef, type MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

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

/** The ruler sits at this clientY; lane offsets are relative to it. */
const RULER_TOP = 200;

function setup(onMarkerMoveCommit: ReturnType<typeof vi.fn>) {
  const cameraXRef = createRef<number>() as MutableRefObject<number>;
  cameraXRef.current = 0;
  const ppsRef = createRef<number>() as MutableRefObject<number>;
  ppsRef.current = 100;
  const rulerRef = createRef<HTMLElement>() as MutableRefObject<HTMLElement | null>;
  const renders = { count: 0 };
  const previewRefs: Array<{ current: unknown }> = [];

  function Harness() {
    renders.count += 1;
    const drag = useMarkerMoveDrag({
      song: SONG,
      snapEnabled: false,
      cameraXRef,
      rulerRef,
      livePixelsPerSecondRef: ppsRef,
      pixelsPerSecond: 100,
      onMarkerMoveCommit,
    });
    previewRefs[0] = drag.markerMovePreviewRef;
    // The hotspot's `top` follows the preview lane, exactly like the real one
    // — this is what used to break a horizontal-then-vertical drag. El carril
    // sigue siendo estado (cambia una o dos veces por gesto); la POSICIÓN se
    // fue a un ref para no re-renderizar por píxel.
    const previewCategory = drag.markerMovePreviewLane?.category ?? "section";
    const laneTop =
      previewCategory === "cue" ? LANE_CUES.top : LANE_SECTIONS.top;
    return (
      <div ref={rulerRef as MutableRefObject<HTMLDivElement | null>}>
        <button
          type="button"
          data-testid="hotspot"
          data-lane-top={laneTop}
          onPointerDown={(event) => drag.beginMarkerMove(event, "m1", 4)}
          onPointerMove={drag.updateMarkerMove}
          onPointerUp={drag.endMarkerMove}
        />
      </div>
    );
  }

  const view = render(<Harness />);
  const hotspot = view.getByTestId("hotspot");
  if (rulerRef.current) {
    rulerRef.current.getBoundingClientRect = () =>
      ({ top: RULER_TOP, left: 0, width: 800, height: 134 }) as DOMRect;
  }
  // Mirrors the real hotspot: its rect tracks whichever lane the preview says,
  // so it moves out from under the pointer mid-drag.
  hotspot.getBoundingClientRect = () =>
    ({
      top: RULER_TOP + Number(hotspot.dataset.laneTop ?? LANE_SECTIONS.top),
      left: 0,
      width: 68,
      height: 26,
    }) as DOMRect;
  Object.defineProperty(hotspot, "offsetWidth", { value: 68 });
  hotspot.setPointerCapture = () => {};
  hotspot.releasePointerCapture = () => {};
  return { hotspot, renders, previewRefs };
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

/** clientY for a point at the vertical centre of `lane`. */
function clientYFor(lane: { top: number; height: number }) {
  return RULER_TOP + laneCentre(lane);
}

/**
 * Press on the section lane, then travel through `waypoints` (each a
 * [clientX, clientY]) and release at the last one.
 */
function drag(hotspot: HTMLElement, ...waypoints: [number, number][]) {
  fireEvent(hotspot, pointer("pointerdown", 0, clientYFor(LANE_SECTIONS)));
  for (const [x, y] of waypoints) {
    fireEvent(hotspot, pointer("pointermove", x, y));
  }
  const [lastX, lastY] = waypoints[waypoints.length - 1];
  fireEvent(hotspot, pointer("pointerup", lastX, lastY));
}

describe("useMarkerMoveDrag lane changes", () => {
  /**
   * Renders provocados por `count` movimientos de puntero dentro del mismo
   * carril, sin contar los del montaje ni los del `pointerdown`.
   */
  function rendersDuringDrag(count: number) {
    // Dos arneses en el mismo test: hay que desmontar el anterior o el
    // localizador encuentra dos hotspots.
    cleanup();
    const { hotspot, renders, previewRefs } = setup(vi.fn());
    const y = clientYFor(LANE_SECTIONS);
    fireEvent(hotspot, pointer("pointerdown", 0, y));
    const before = renders.count;
    for (let index = 1; index <= count; index += 1) {
      fireEvent(hotspot, pointer("pointermove", index * 10, y));
    }
    const preview = previewRefs[0].current as { startSeconds: number } | null;
    return { renders: renders.count - before, preview };
  }

  it("los renders no crecen con los movimientos del puntero", () => {
    const pocos = rendersDuringDrag(5);
    const muchos = rendersDuringDrag(50);

    // Éste es el criterio del paso 02. Antes era un render POR movimiento, así
    // que 50 movimientos costaban diez veces más que 5.
    expect(muchos.renders).toBe(pocos.renders);
    // Y ese número fijo es pequeño: sólo el encendido de las bandas de carril
    // al arrancar el gesto, que sí es trabajo legítimo de React.
    expect(muchos.renders).toBeLessThanOrEqual(2);

    // Guarda: si el arrastre no hubiera avanzado, lo de arriba no probaría
    // nada. 500 px a 100 px/s desde el segundo 4 = 9 s.
    expect(muchos.preview?.startSeconds).toBeCloseTo(9, 6);
    expect(pocos.preview?.startSeconds).toBeCloseTo(4.5, 6);
  });

  it("el cruce de carril sí re-renderiza, y sólo una vez", () => {
    const onMarkerMoveCommit = vi.fn();
    const { hotspot, renders } = setup(onMarkerMoveCommit);

    fireEvent(hotspot, pointer("pointerdown", 0, clientYFor(LANE_SECTIONS)));
    // Asienta el carril inicial antes de medir el cruce.
    fireEvent(hotspot, pointer("pointermove", 10, clientYFor(LANE_SECTIONS)));
    const before = renders.count;

    for (let index = 1; index <= 5; index += 1) {
      fireEvent(
        hotspot,
        pointer("pointermove", 10 + index * 10, clientYFor(LANE_CUES)),
      );
    }

    // El carril es un cambio DISCRETO: cruzar cuesta un render (más, como
    // mucho, el de bail-out de React), no uno por movimiento.
    expect(renders.count - before).toBeLessThanOrEqual(2);
    expect(renders.count - before).toBeGreaterThanOrEqual(1);
  });

  it("commits the new category when dropped on the cue lane", () => {
    const onMarkerMoveCommit = vi.fn();
    const { hotspot } = setup(onMarkerMoveCommit);

    drag(hotspot, [0, clientYFor(LANE_CUES)]);

    expect(onMarkerMoveCommit).toHaveBeenCalledTimes(1);
    expect(onMarkerMoveCommit.mock.calls[0][2]).toBe("cue");
  });

  it("commits the lane change after moving horizontally first", () => {
    // The reported bug. Dragging sideways re-renders the hotspot, which moves
    // it under the pointer; anchoring the vertical hit-test to the hotspot's
    // grab-time rect then reported the wrong lane, so the marker kept its
    // count-in. Resolving against the ruler (which stays put) fixes it.
    const onMarkerMoveCommit = vi.fn();
    const { hotspot } = setup(onMarkerMoveCommit);

    drag(
      hotspot,
      [120, clientYFor(LANE_SECTIONS)], // sideways first...
      [120, clientYFor(LANE_CUES)], // ...then up into the cue lane
    );

    expect(onMarkerMoveCommit).toHaveBeenCalledTimes(1);
    expect(onMarkerMoveCommit.mock.calls[0][2]).toBe("cue");
  });

  it("still commits the lane change when the drag wanders between lanes", () => {
    // Crossing back and forth must leave the marker in whichever lane it was
    // released over, not wherever it happened to pass through.
    const onMarkerMoveCommit = vi.fn();
    const { hotspot } = setup(onMarkerMoveCommit);

    drag(
      hotspot,
      [40, clientYFor(LANE_CUES)],
      [80, clientYFor(LANE_SECTIONS)],
      [120, clientYFor(LANE_CUES)],
    );

    expect(onMarkerMoveCommit.mock.calls[0][2]).toBe("cue");
  });

  it("omits the category on a purely horizontal move", () => {
    // A plain nudge must not write an override the user never asked for.
    const onMarkerMoveCommit = vi.fn();
    const { hotspot } = setup(onMarkerMoveCommit);

    drag(hotspot, [50, clientYFor(LANE_SECTIONS)]);

    expect(onMarkerMoveCommit).toHaveBeenCalledTimes(1);
    expect(onMarkerMoveCommit.mock.calls[0][2]).toBeUndefined();
  });

  it("omits the category when dropped back in its original lane", () => {
    // Wandering into the cue lane and returning is not an edit of the category.
    const onMarkerMoveCommit = vi.fn();
    const { hotspot } = setup(onMarkerMoveCommit);

    drag(
      hotspot,
      [60, clientYFor(LANE_CUES)],
      [60, clientYFor(LANE_SECTIONS)],
    );

    expect(onMarkerMoveCommit.mock.calls[0][2]).toBeUndefined();
  });
});
