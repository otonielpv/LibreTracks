import { createRef, useRef, type MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import type { SongView } from "@libretracks/shared/models";
import { useRegionDrag } from "./useRegionDrag";
import { regionHotspotBounds } from "./regionHotspotBounds";

/**
 * Arrastre completo a través del hook real, con eventos de puntero.
 *
 * Cubre las dos cosas que el paso 02 de `docs/plans/ui-performance` promete, y
 * que son independientes entre sí:
 *
 * 1. **Que siga funcionando.** La banda sigue al puntero y el commit recibe el
 *    delta correcto. Este código no tenía NINGÚN test unitario antes de
 *    extraerlo de `TimelineCanvasPane`; sólo lo rozaba un E2E de Windows.
 * 2. **Que no pase por React.** Cero renders del componente durante los
 *    `pointermove`. Medido antes del cambio: 144 renders/segundo, uno por
 *    frame (docs/plans/ui-performance/state/01.md).
 */

const PPS = 100;

const SONG = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  sectionMarkers: [],
  clips: [],
  tracks: [],
  regions: [
    {
      id: "r1",
      name: "Uno",
      startSeconds: 10,
      endSeconds: 20,
      transposeSemitones: 0,
      warpEnabled: false,
    },
    {
      id: "r2",
      name: "Dos",
      startSeconds: 40,
      endSeconds: 50,
      transposeSemitones: 0,
      warpEnabled: false,
    },
  ],
} as unknown as SongView;

function setup(onRegionMoveCommit: ReturnType<typeof vi.fn>) {
  const ppsRef = createRef<number>() as MutableRefObject<number>;
  ppsRef.current = PPS;
  const renders = { count: 0 };

  function Harness() {
    renders.count += 1;
    const drag = useRegionDrag({
      song: SONG,
      pixelsPerSecond: PPS,
      livePixelsPerSecondRef: ppsRef,
      clipsByTrack: {},
      // Sin snap: el test comprueba el transporte del delta, no la rejilla.
      snapEnabled: false,
      onRegionMoveCommit,
    });
    const region = SONG.regions[0];
    const { leftPx, widthPx } = regionHotspotBounds(
      region.startSeconds,
      region.endSeconds,
      PPS,
    );
    // Espeja lo que hace el panel: React pinta el reposo, el arrastre escribe
    // el estilo por su cuenta.
    const selfRef = useRef<HTMLButtonElement | null>(null);
    return (
      <button
        type="button"
        data-testid="hotspot"
        ref={(element) => {
          selfRef.current = element;
          drag.registerRegionHotspot(region.id, element);
        }}
        style={{ position: "absolute", left: leftPx, width: widthPx }}
        onPointerDown={(event) => drag.beginRegionMove(event, region)}
        onPointerMove={drag.updateRegionMove}
        onPointerUp={drag.endRegionMove}
      />
    );
  }

  const view = render(<Harness />);
  const hotspot = view.getByTestId("hotspot") as HTMLButtonElement;
  // jsdom no implementa la captura de puntero.
  hotspot.setPointerCapture = () => {};
  hotspot.releasePointerCapture = () => {};
  return { hotspot, renders, view };
}

/**
 * jsdom no tiene `PointerEvent`, y un init suelto de `fireEvent` pierde
 * `button` y `pointerId` por el camino hacia el evento sintético de React —
 * que es justo lo que el hook usa para emparejar el down con sus moves. Mismo
 * apaño que `useMarkerMoveDrag.test.tsx`, donde ya está documentado.
 */
function pointer(type: string, clientX: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

/** Como `pointer`, pero con otro botón del ratón. */
function pointerWithButton(type: string, clientX: number, button: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    button,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

function leftPx(element: HTMLElement) {
  return Number.parseFloat(element.style.left);
}

describe("useRegionDrag", () => {
  it("mueve la banda con el puntero y confirma el delta", () => {
    const onRegionMoveCommit = vi.fn();
    const { hotspot } = setup(onRegionMoveCommit);

    // Reposo: 10 s x 100 px/s.
    expect(leftPx(hotspot)).toBe(1000);

    fireEvent(hotspot, pointer("pointerdown", 1000));
    fireEvent(hotspot, pointer("pointermove", 1250));

    // 250 px a 100 px/s = 2,5 s -> arranca en 12,5 s -> left 1250.
    expect(leftPx(hotspot)).toBe(1250);

    fireEvent(hotspot, pointer("pointerup", 1250));

    expect(onRegionMoveCommit).toHaveBeenCalledTimes(1);
    const [regionId, deltaSeconds] = onRegionMoveCommit.mock.calls[0];
    expect(regionId).toBe("r1");
    expect(deltaSeconds).toBeCloseTo(2.5, 6);
  });

  it("NO re-renderiza el componente durante el arrastre", () => {
    const onRegionMoveCommit = vi.fn();
    const { hotspot, renders } = setup(onRegionMoveCommit);

    const before = renders.count;
    fireEvent(hotspot, pointer("pointerdown", 1000));
    for (let index = 1; index <= 40; index += 1) {
      fireEvent(hotspot, pointer("pointermove", 1000 + index * 5));
    }

    // Éste es el criterio del paso 02. Antes era un render por movimiento.
    expect(renders.count - before).toBe(0);
    // Y la guarda: si el arrastre no hubiera movido nada, el cero de arriba no
    // significaría nada.
    expect(leftPx(hotspot)).toBe(1200);
  });

  it("devuelve la banda a su sitio al soltar sin cambios", () => {
    const onRegionMoveCommit = vi.fn();
    const { hotspot } = setup(onRegionMoveCommit);

    fireEvent(hotspot, pointer("pointerdown", 1000));
    fireEvent(hotspot, pointer("pointermove", 1300));
    expect(leftPx(hotspot)).toBe(1300);
    // Vuelta exacta al origen: el commit no debe dispararse.
    fireEvent(hotspot, pointer("pointermove", 1000));
    fireEvent(hotspot, pointer("pointerup", 1000));

    expect(onRegionMoveCommit).not.toHaveBeenCalled();
    // Como React no re-renderiza (nada cambió en sus props), la restauración
    // imperativa es lo único que devuelve la banda a su sitio.
    expect(leftPx(hotspot)).toBe(1000);
  });

  it("no deja pasar la banda por encima de la canción anterior", () => {
    const onRegionMoveCommit = vi.fn();
    const { hotspot } = setup(onRegionMoveCommit);

    fireEvent(hotspot, pointer("pointerdown", 1000));
    // Un tirón enorme a la izquierda: la región empieza en 10 s y no hay
    // vecina por delante, así que el tope es 0 s.
    fireEvent(hotspot, pointer("pointermove", -5000));

    expect(leftPx(hotspot)).toBe(0);
  });

  it("ignora los botones que no son el principal", () => {
    const onRegionMoveCommit = vi.fn();
    const { hotspot } = setup(onRegionMoveCommit);

    fireEvent(hotspot, pointerWithButton("pointerdown", 1000, 2));
    fireEvent(hotspot, pointer("pointermove", 1400));

    expect(leftPx(hotspot)).toBe(1000);
    fireEvent(hotspot, pointer("pointerup", 1400));
    expect(onRegionMoveCommit).not.toHaveBeenCalled();
  });
});
