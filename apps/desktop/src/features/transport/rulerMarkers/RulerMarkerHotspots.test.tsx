import { createRef, type MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { SongView } from "../desktopApi";
import { useMarkerMoveDrag } from "../timeline/useMarkerMoveDrag";
import { useTouchContextMenu } from "../timeline/useTouchContextMenu";
import { selectedRulerMarkers, useTimelineUIStore } from "../uiStore";
import { RulerMarkerHotspots } from "./RulerMarkerHotspots";

/**
 * Las zonas táctiles con el arrastre REAL: entre el clic, la selección y el
 * commit hay tres piezas, y cada una puede estar bien por separado mientras el
 * dato se pierde entre ellas.
 */

const SONG = {
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 60,
  regions: [],
  sectionMarkers: [
    { id: "s1", name: "Intro", startSeconds: 2, kind: "intro" },
    { id: "s2", name: "Verse", startSeconds: 6, kind: "verse" },
  ],
  tempoMarkers: [{ id: "t1", startSeconds: 4, bpm: 100 }],
  timeSignatureMarkers: [{ id: "ts1", startSeconds: 8, signature: "3/4" }],
} as unknown as SongView;

function setup() {
  const cameraXRef = createRef<number>() as MutableRefObject<number>;
  cameraXRef.current = 0;
  const ppsRef = createRef<number>() as MutableRefObject<number>;
  ppsRef.current = 100;
  const props = {
    onMarkerPrimaryAction: vi.fn(),
    onMarkerContextMenu: vi.fn(),
    onTempoMarkerContextMenu: vi.fn(),
    onTimeSignatureMarkerContextMenu: vi.fn(),
    onRulerMarkersContextMenu: vi.fn(),
    onGroupMoveCommit: vi.fn(),
    onMarkerMoveCommit: vi.fn(),
  };

  function Harness() {
    const drag = useMarkerMoveDrag({
      song: SONG,
      snapEnabled: false,
      cameraXRef,
      livePixelsPerSecondRef: ppsRef,
      pixelsPerSecond: 100,
      onMarkerMoveCommit: props.onMarkerMoveCommit,
      onGroupMoveCommit: props.onGroupMoveCommit,
    });
    const touch = useTouchContextMenu();
    return (
      <RulerMarkerHotspots
        song={SONG}
        pixelsPerSecond={100}
        markerMovePreviewLane={drag.markerMovePreviewLane}
        markerTouchContextMenu={touch}
        beginMarkerMove={drag.beginMarkerMove}
        updateMarkerMove={drag.updateMarkerMove}
        endMarkerMove={drag.endMarkerMove}
        markerDidDragRef={drag.markerDidDragRef}
        midiLearnMode={null}
        onMidiLearnTarget={() => false}
        onMarkerPrimaryAction={props.onMarkerPrimaryAction}
        onMarkerContextMenu={props.onMarkerContextMenu}
        onTempoMarkerContextMenu={props.onTempoMarkerContextMenu}
        onTimeSignatureMarkerContextMenu={props.onTimeSignatureMarkerContextMenu}
        onRulerMarkersContextMenu={props.onRulerMarkersContextMenu}
      />
    );
  }

  render(<Harness />);
  return props;
}

const section = (name: string) => screen.getByRole("button", { name: `${name} - carril central` });
const tempoHotspot = () => screen.getByRole("button", { name: /tempo 100/ });
const selected = () => selectedRulerMarkers(useTimelineUIStore.getState());

/** jsdom no tiene PointerEvent y `fireEvent.pointer*` pierde `pointerId`. */
function pointer(target: Element, type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}

function dragBy(target: Element, dx: number) {
  pointer(target, "pointerdown", 100);
  pointer(target, "pointermove", 100 + dx / 2);
  pointer(target, "pointermove", 100 + dx);
  pointer(target, "pointerup", 100 + dx);
  // El clic sintetico que sigue al soltar: lo debe tragar el arrastre.
  fireEvent.click(target);
}

beforeEach(() => {
  useTimelineUIStore.getState().clearSelection();
});
afterEach(cleanup);

describe("seleccion multiple de marcas en la regla", () => {
  it("Ctrl+clic elige la marca sin programar el salto", () => {
    const props = setup();
    fireEvent.click(section("Intro"), { ctrlKey: true });
    fireEvent.click(section("Verse"), { metaKey: true });
    expect(props.onMarkerPrimaryAction).not.toHaveBeenCalled();
    expect(selected()).toEqual([
      { kind: "section", id: "s1" },
      { kind: "section", id: "s2" },
    ]);
    expect(section("Intro").getAttribute("aria-pressed")).toBe("true");
  });

  it("un clic normal sigue siendo el de siempre: seleccionar y saltar", () => {
    const props = setup();
    fireEvent.click(section("Verse"));
    expect(props.onMarkerPrimaryAction).toHaveBeenCalledWith("s2");
  });

  it("Ctrl+clic y luego Shift+clic coge todas las de en medio, tempo incluido", () => {
    setup();
    fireEvent.click(section("Intro"), { ctrlKey: true });
    fireEvent.click(section("Verse"), { shiftKey: true });
    expect(selected()).toEqual([
      { kind: "section", id: "s1" },
      { kind: "tempo", id: "t1" },
      { kind: "section", id: "s2" },
    ]);
    expect(tempoHotspot().getAttribute("aria-pressed")).toBe("true");
  });

  it("el clic derecho sobre una del grupo abre el menu del grupo", () => {
    const props = setup();
    useTimelineUIStore.getState().setSelectedMarkers([
      { kind: "section", id: "s1" },
      { kind: "tempo", id: "t1" },
    ]);
    fireEvent.contextMenu(tempoHotspot());
    expect(props.onRulerMarkersContextMenu).toHaveBeenCalledTimes(1);
    expect(props.onRulerMarkersContextMenu.mock.calls[0][1]).toHaveLength(2);
    expect(props.onTempoMarkerContextMenu).not.toHaveBeenCalled();

    // Una que no esta en el grupo abre su menu de siempre.
    fireEvent.contextMenu(section("Verse"));
    expect(props.onMarkerContextMenu).toHaveBeenCalledWith(expect.anything(), "s2");
  });

  it("arrastrar una del grupo mueve el grupo entero", () => {
    const props = setup();
    useTimelineUIStore.getState().setSelectedMarkers([
      { kind: "section", id: "s1" },
      { kind: "tempo", id: "t1" },
    ]);
    // 100 px a 100 px/s: un segundo.
    dragBy(section("Intro"), 100);
    expect(props.onGroupMoveCommit).toHaveBeenCalledTimes(1);
    const [markers, delta] = props.onGroupMoveCommit.mock.calls[0];
    expect(markers).toHaveLength(2);
    expect(delta).toBeCloseTo(1);
    expect(props.onMarkerMoveCommit).not.toHaveBeenCalled();
    expect(props.onMarkerPrimaryAction).not.toHaveBeenCalled();
  });

  it("Ctrl+clic suma tambien tempo y compas a una seccion", () => {
    setup();
    fireEvent.click(section("Intro"), { ctrlKey: true });
    fireEvent.click(tempoHotspot(), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: /compás 3\/4/ }), { ctrlKey: true });
    expect(selected()).toEqual([
      { kind: "section", id: "s1" },
      { kind: "tempo", id: "t1" },
      { kind: "timeSignature", id: "ts1" },
    ]);
  });

  it("un tempo sin seleccionar no se arrastra: no se mueve por rozarlo", () => {
    const props = setup();
    dragBy(tempoHotspot(), 100);
    expect(props.onGroupMoveCommit).not.toHaveBeenCalled();
  });

  it("un tempo seleccionado se arrastra solo", () => {
    const props = setup();
    fireEvent.click(tempoHotspot());
    expect(selected()).toEqual([{ kind: "tempo", id: "t1" }]);
    dragBy(tempoHotspot(), -100);
    expect(props.onGroupMoveCommit).toHaveBeenCalledWith([{ kind: "tempo", id: "t1" }], expect.closeTo(-1), false);
  });
});
