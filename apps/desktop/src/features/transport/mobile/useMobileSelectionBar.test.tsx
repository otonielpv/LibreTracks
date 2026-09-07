// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMobileSelectionBar } from "./useMobileSelectionBar";
import type { TimelineMenus } from "../menus/timelineMenus";

afterEach(cleanup);

function mountHook(args: {
  timelineMenus: TimelineMenus;
  getPlayheadSeconds: () => number;
}) {
  const result: { current: ReturnType<typeof useMobileSelectionBar> | null } = {
    current: null,
  };
  function Probe() {
    result.current = useMobileSelectionBar({
      ...args,
      onAddAudios: vi.fn(),
    });
    return null;
  }
  render(<Probe />);
  return result;
}

describe("lo que la barra tactil necesita del panel", () => {
  it("no expone las factories hasta que tienen dependencias", () => {
    // Las factories leen sus deps de un ref que el panel rellena EN UN EFECTO,
    // y los efectos de los hijos corren antes que los del padre.
    const seen: Array<boolean> = [];
    function Probe() {
      const { menus } = useMobileSelectionBar({
        timelineMenus: {} as TimelineMenus,
        getPlayheadSeconds: () => 0,
        onAddAudios: vi.fn(),
      });
      seen.push(menus !== null);
      return null;
    }
    render(<Probe />);
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
  });

  it("la marca se crea en el tiempo MOSTRADO al pulsar, no al elegir el tipo", () => {
    // El usuario pulsa "+ Seccion" y la reproduccion sigue corriendo mientras
    // recorre las 22 opciones. La marca tiene que caer donde estaba el cabezal
    // cuando lo pidio.
    let playhead = 12.5;
    const openCreateSectionKindMenu = vi.fn();
    const result = mountHook({
      timelineMenus: { openCreateSectionKindMenu } as unknown as TimelineMenus,
      getPlayheadSeconds: () => playhead,
    });

    result.current!.creation.onCreateSection();
    playhead = 40; // sigue reproduciendo mientras elige el tipo

    expect(openCreateSectionKindMenu).toHaveBeenCalledWith(12.5);
  });

  it("seccion y aviso abren vocabularios distintos", () => {
    const openCreateSectionKindMenu = vi.fn();
    const openCreateCueKindMenu = vi.fn();
    const result = mountHook({
      timelineMenus: {
        openCreateSectionKindMenu,
        openCreateCueKindMenu,
      } as unknown as TimelineMenus,
      getPlayheadSeconds: () => 3,
    });

    result.current!.creation.onCreateSection();
    result.current!.creation.onCreateCue();
    expect(openCreateSectionKindMenu).toHaveBeenCalledWith(3);
    expect(openCreateCueKindMenu).toHaveBeenCalledWith(3);
  });
});
