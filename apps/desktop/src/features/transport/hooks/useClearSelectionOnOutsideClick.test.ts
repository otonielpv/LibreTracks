// @vitest-environment jsdom
import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useTimelineUIStore } from "../uiStore";
import { useClearSelectionOnOutsideClick } from "./useClearSelectionOnOutsideClick";

function tap(target: HTMLElement, from = { x: 100, y: 100 }, to = from) {
  fireEvent.mouseDown(target, { button: 0, clientX: from.x, clientY: from.y });
  fireEvent.click(target, { button: 0, clientX: to.x, clientY: to.y });
}

function surface(className?: string) {
  const element = document.createElement("div");
  if (className) {
    element.className = className;
  }
  document.body.append(element);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = "";
  useTimelineUIStore.getState().selectTrack(["track-1"]);
});

afterEach(() => {
  document.body.innerHTML = "";
  useTimelineUIStore.getState().clearSelection();
});

describe("deseleccionar pulsando fuera", () => {
  it("deshace la selección desde cualquier sitio, no sólo desde un hueco vacío", () => {
    renderHook(() => useClearSelectionOnOutsideClick());

    tap(surface("lt-transport-bar"));

    expect(useTimelineUIStore.getState().selectedTrackIds).toEqual([]);
  });

  // Mover la cámara o un fader emite igualmente un `click` al soltar.
  it("arrastrar no deshace la selección", () => {
    renderHook(() => useClearSelectionOnOutsideClick());

    tap(surface(), { x: 100, y: 100 }, { x: 180, y: 100 });

    expect(useTimelineUIStore.getState().selectedTrackIds).toEqual(["track-1"]);
  });

  it.each([
    ["una cabecera de pista", "lt-track-header-row"],
    ["una tira del mixer", "lt-compact-mixer-strip"],
    ["un carril del timeline", "lt-track-lane-row"],
    ["un menú contextual", "lt-context-menu"],
    ["un popover de color", "lt-color-popover"],
    ["un diálogo", "lt-dialog-layer"],
  ])("no toca la selección al pulsar %s", (_label, className) => {
    renderHook(() => useClearSelectionOnOutsideClick());

    tap(surface(className));

    expect(useTimelineUIStore.getState().selectedTrackIds).toEqual(["track-1"]);
  });

  it("respeta lo que se haya seleccionado durante la misma pulsación", () => {
    renderHook(() => useClearSelectionOnOutsideClick());
    // Una superficie que selecciona al pulsarla y NO está en la lista: la marca
    // de sección del ruler. La red de seguridad la cubre sin apuntarla.
    const hotspot = surface("lt-marker-hotspot");
    hotspot.addEventListener("click", () => {
      useTimelineUIStore.getState().selectSection("section-1");
    });

    tap(hotspot);

    expect(useTimelineUIStore.getState().selectedSectionId).toBe("section-1");
  });

  it("deja de escuchar al desmontarse", () => {
    const { unmount } = renderHook(() => useClearSelectionOnOutsideClick());
    unmount();

    tap(surface());

    expect(useTimelineUIStore.getState().selectedTrackIds).toEqual(["track-1"]);
  });
});
