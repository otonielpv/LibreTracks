// Estado compartido del panel Ritmo (plan drum-loops, paso 06): biblioteca,
// estado vivo que llega de `audio:rhythm` y lo que la UI tiene abierto.
//
// El paso que suena NO es estado de React (D13): va a `rhythmStepRef`, que la
// tira de pasos lee con rAF. Así un `audio:rhythm` con solo el paso nuevo no
// re-renderiza ninguna fila.
import { create } from "zustand";

import type { LoopRowMeter, RhythmLibrary, RhythmMeterPayload } from "@libretracks/shared/models";

export type RhythmSurface = "loops" | "oneShots";

type RhythmStore = {
  library: RhythmLibrary | null;
  loopPlaying: boolean;
  loopRows: LoopRowMeter[];
  /** Pads sonando, bits 0..11. */
  oneShotsActive: number;
  /** Superficie visible en `short` (conmutador Loops | One shots). */
  surface: RhythmSurface;
  /** Modo edición de los pads (✎). */
  padEditMode: boolean;
  setLibrary: (library: RhythmLibrary) => void;
  applyMeters: (payload: RhythmMeterPayload) => void;
  setSurface: (surface: RhythmSurface) => void;
  setPadEditMode: (on: boolean) => void;
  reset: () => void;
};

/** Paso y compás vivos, fuera de React. */
export const rhythmStepRef: { step: number; bar: number; playing: boolean } = {
  step: -1,
  bar: 0,
  playing: false,
};

const INITIAL = {
  library: null,
  loopPlaying: false,
  loopRows: [] as LoopRowMeter[],
  oneShotsActive: 0,
  surface: "loops" as RhythmSurface,
  padEditMode: false,
};

function sameRows(a: LoopRowMeter[], b: LoopRowMeter[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.enabled !== y.enabled ||
      x.variation !== y.variation ||
      x.pendingVariation !== y.pendingVariation ||
      x.pendingEnabled !== y.pendingEnabled
    ) {
      return false;
    }
  }
  return true;
}

export const useRhythmStore = create<RhythmStore>((set, get) => ({
  ...INITIAL,
  setLibrary: (library) => set({ library }),
  applyMeters: (payload) => {
    rhythmStepRef.step = payload.loopStep;
    rhythmStepRef.bar = payload.loopBar;
    rhythmStepRef.playing = payload.loopPlaying;
    const current = get();
    const patch: Partial<RhythmStore> = {};
    if (current.loopPlaying !== payload.loopPlaying) patch.loopPlaying = payload.loopPlaying;
    if (current.oneShotsActive !== payload.oneShotsActive) patch.oneShotsActive = payload.oneShotsActive;
    if (!sameRows(current.loopRows, payload.loopRows)) patch.loopRows = payload.loopRows;
    // Solo el paso cambió: ni un set, ni un render.
    if (Object.keys(patch).length > 0) set(patch);
  },
  setSurface: (surface) => set({ surface }),
  setPadEditMode: (padEditMode) => set({ padEditMode }),
  reset: () => {
    rhythmStepRef.step = -1;
    rhythmStepRef.bar = 0;
    rhythmStepRef.playing = false;
    set({ ...INITIAL });
  },
}));

/** El botón Ritmo se ilumina con el loop sonando o algún pad vivo. */
export function selectRhythmActive(state: Pick<RhythmStore, "loopPlaying" | "oneShotsActive">): boolean {
  return state.loopPlaying || state.oneShotsActive !== 0;
}
