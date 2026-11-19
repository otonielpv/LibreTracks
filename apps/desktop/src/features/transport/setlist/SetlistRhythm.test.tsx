import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useRhythmStore } from "../rhythm/rhythmStore";
import { useSetlistRhythm } from "./SetlistRhythm";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import type { SetlistLayoutClass } from "./useSetlistLayout";

/** El botón «Ritmo» de la barra superior y las pestañas del Setlist son el
 * mismo interruptor (antes el botón se iluminaba en el Setlist sin abrir nada). */
const toggleButton = () => act(() => useRhythmStore.getState().toggleOpen("setlist"));
const open = () => useRhythmStore.getState().openByView.setlist;
const tab = () => useSetlistStore.getState().bottomTab;

describe("useSetlistRhythm", () => {
  beforeEach(() => {
    useSetlistStore.setState(INITIAL_SETLIST_STATE);
    useRhythmStore.getState().reset();
  });

  it("wide: el botón abre la pestaña Ritmo y, pulsado otra vez, vuelve a Pistas", () => {
    renderHook(() => useSetlistRhythm("wide"));
    toggleButton();
    expect(tab()).toBe("rhythm");
    toggleButton();
    expect(tab()).toBe("tracks");
  });

  it("medium: abre Loops y despliega la consola plegada", () => {
    useSetlistStore.setState({ mixerCollapsed: true });
    renderHook(() => useSetlistRhythm("medium"));
    toggleButton();
    expect(tab()).toBe("loops");
    expect(useSetlistStore.getState().mixerCollapsed).toBe(false);
  });

  it("elegir la pestaña a mano ilumina el botón y salir de ella lo apaga", () => {
    renderHook(() => useSetlistRhythm("medium"));
    act(() => useSetlistStore.getState().setBottomTab("oneShots"));
    expect(open()).toBe(true);
    act(() => useSetlistStore.getState().setBottomTab("pads"));
    expect(open()).toBe(false);
  });

  it("al entrar manda la pestaña: un abierto persistido no salta a Ritmo", () => {
    act(() => useRhythmStore.getState().setOpen("setlist", true));
    renderHook(() => useSetlistRhythm("wide"));
    expect(tab()).toBe("tracks");
    expect(open()).toBe(false);
  });

  it("teléfono: no toca las pestañas y devuelve si el panel acoplado está abierto", () => {
    const { result } = renderHook(({ layout }: { layout: SetlistLayoutClass }) => useSetlistRhythm(layout), {
      initialProps: { layout: "short" },
    });
    expect(result.current).toBe(false);
    toggleButton();
    expect(result.current).toBe(true);
    expect(tab()).toBe("tracks");
  });
});
