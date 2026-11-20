import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SongRegionSummary } from "@libretracks/shared/models";

import "../../../test/testUtils";
import { PendingPitchApplyBar } from "./PendingPitchApplyBar";
import { usePendingPitchStore } from "./pendingPitchStore";
import { usePendingPitchGate } from "./usePendingPitchGate";

function region(id: string, transposeSemitones = 0): SongRegionSummary {
  return { id, name: id, transposeSemitones } as SongRegionSummary;
}

function setup(enabled: boolean, selected: SongRegionSummary | null = region("r1")) {
  const applyTranspose = vi.fn();
  const applyTempo = vi.fn();
  const hook = renderHook(
    (props: { enabled: boolean; selectedRegion: SongRegionSummary | null }) =>
      usePendingPitchGate({ ...props, applyTranspose, applyTempo }),
    { initialProps: { enabled, selectedRegion: selected } },
  );
  return { hook, applyTranspose, applyTempo };
}

describe("usePendingPitchGate", () => {
  it("con el ajuste apagado aplica al momento, como siempre", () => {
    const { hook, applyTranspose, applyTempo } = setup(false);
    hook.result.current.onTransposeChange(2);
    hook.result.current.onTempoChange(region("r1"), 130);
    expect(applyTranspose).toHaveBeenCalledWith(2);
    expect(applyTempo).toHaveBeenCalledWith(region("r1"), 130);
    expect(usePendingPitchStore.getState().regionId).toBeNull();
  });

  it("encendido, pasar por +1 para llegar a +2 no envía nada hasta aplicar", () => {
    const { hook, applyTranspose, applyTempo } = setup(true);
    act(() => hook.result.current.onTransposeChange(1));
    act(() => hook.result.current.onTransposeChange(2));
    act(() => hook.result.current.onTempoChange(region("r1"), 128));
    expect(applyTranspose).not.toHaveBeenCalled();
    expect(applyTempo).not.toHaveBeenCalled();
    expect(usePendingPitchStore.getState()).toMatchObject({
      regionId: "r1",
      transpose: 2,
      bpm: 128,
    });

    act(() => usePendingPitchStore.getState().apply?.());
    expect(applyTranspose).toHaveBeenCalledTimes(1);
    expect(applyTranspose).toHaveBeenCalledWith(2);
    expect(applyTempo).toHaveBeenCalledWith(region("r1"), 128);
    expect(usePendingPitchStore.getState().regionId).toBeNull();
  });

  it("volver al tono que ya suena no deja nada pendiente", () => {
    const { hook } = setup(true, region("r1", 3));
    act(() => hook.result.current.onTransposeChange(4));
    act(() => hook.result.current.onTransposeChange(3));
    expect(usePendingPitchStore.getState().regionId).toBeNull();
  });

  it("cambiar de canción o apagar el ajuste descarta lo pendiente", () => {
    const { hook, applyTranspose } = setup(true);
    act(() => hook.result.current.onTransposeChange(2));
    hook.rerender({ enabled: true, selectedRegion: region("r2") });
    expect(usePendingPitchStore.getState().regionId).toBeNull();

    act(() => hook.result.current.onTransposeChange(5));
    hook.rerender({ enabled: false, selectedRegion: region("r2") });
    expect(usePendingPitchStore.getState().regionId).toBeNull();
    expect(applyTranspose).not.toHaveBeenCalled();
  });
});

describe("PendingPitchApplyBar", () => {
  it("no aparece sin nada pendiente y aplica o cancela lo elegido", () => {
    const { hook, applyTranspose } = setup(true);
    const { container } = render(<PendingPitchApplyBar regionId="r1" />);
    expect(container.textContent).toBe("");

    act(() => hook.result.current.onTransposeChange(2));
    expect(screen.getByText(/\+2/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /cancelar|cancel/i }));
    expect(usePendingPitchStore.getState().regionId).toBeNull();
    expect(applyTranspose).not.toHaveBeenCalled();

    act(() => hook.result.current.onTransposeChange(-1));
    fireEvent.click(screen.getByRole("button", { name: /aplicar|apply/i }));
    expect(applyTranspose).toHaveBeenCalledWith(-1);
  });

  it("lo pendiente de otra región no se pinta aquí", () => {
    const { hook } = setup(true, region("r2"));
    act(() => hook.result.current.onTransposeChange(2));
    const { container } = render(<PendingPitchApplyBar regionId="r1" />);
    expect(container.textContent).toBe("");
  });
});
