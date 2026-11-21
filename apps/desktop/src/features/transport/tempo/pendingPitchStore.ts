import { create } from "zustand";

/**
 * Tono y tempo elegidos pero aún sin aplicar, para el ajuste «Cambio de tono
 * preparado». Con él activo cada cambio pone el audio a prepararse, así que
 * pasar por +1 para llegar a +2 prepararía un tono que nadie quiere oír: los
 * controles escriben aquí y solo «Aplicar» llega al backend.
 *
 * Store (y no estado de un componente) porque el mismo valor pendiente se ve
 * en la barra de la DAW, en la Setlist y en la Compacta: las vistas comparten
 * un solo modelo. `apply` lo registra usePendingPitchGate con los handlers de
 * verdad.
 */
/** Tono y tempo que tenía la región antes del último «Aplicar». */
export type AppliedPitchUndo = {
  regionId: string;
  transpose: number | null;
  bpm: number | null;
};

export type PendingPitchState = {
  regionId: string | null;
  transpose: number | null;
  bpm: number | null;
  apply: (() => void) | null;
  /**
   * Lo que «Cancelar» del aviso de preparación restaura. Se borra al
   * terminar la preparación o al cambiar de canción.
   */
  undo: AppliedPitchUndo | null;
  /** Vuelve a `undo` (registrado por usePendingPitchGate). */
  revert: (() => void) | null;
  setTranspose: (regionId: string, transpose: number | null) => void;
  setBpm: (regionId: string, bpm: number | null) => void;
  clear: () => void;
};

const EMPTY = { regionId: null, transpose: null, bpm: null } as const;

export const usePendingPitchStore = create<PendingPitchState>((set, get) => ({
  ...EMPTY,
  apply: null,
  undo: null,
  revert: null,
  setTranspose: (regionId, transpose) => {
    const current = get();
    const bpm = current.regionId === regionId ? current.bpm : null;
    set(
      transpose === null && bpm === null
        ? { ...EMPTY }
        : { regionId, transpose, bpm },
    );
  },
  setBpm: (regionId, bpm) => {
    const current = get();
    const transpose = current.regionId === regionId ? current.transpose : null;
    set(
      transpose === null && bpm === null
        ? { ...EMPTY }
        : { regionId, transpose, bpm },
    );
  },
  clear: () => set({ ...EMPTY }),
}));

/** Lo pendiente de una región (nulos si es de otra o no hay nada). */
export function usePendingRegionPitch(regionId: string | null | undefined) {
  const pendingRegionId = usePendingPitchStore((state) => state.regionId);
  const transpose = usePendingPitchStore((state) => state.transpose);
  const bpm = usePendingPitchStore((state) => state.bpm);
  if (!regionId || pendingRegionId !== regionId) {
    return { transpose: null, bpm: null, hasPending: false };
  }
  return { transpose, bpm, hasPending: transpose !== null || bpm !== null };
}

/** Para el `beforeEach` de los tests: un store sobrevive al desmontaje. */
export function resetPendingPitchStore() {
  usePendingPitchStore.setState({ ...EMPTY, apply: null, undo: null, revert: null });
}
