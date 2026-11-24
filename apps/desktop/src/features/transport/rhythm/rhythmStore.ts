// Estado compartido del panel Ritmo (plan drum-loops, paso 06): biblioteca,
// estado vivo que llega de `audio:rhythm` y lo que la UI tiene abierto.
//
// El paso que suena NO es estado de React (D13): va a `rhythmStepRef`, que la
// tira de pasos lee con rAF. Así un `audio:rhythm` con solo el paso nuevo no
// re-renderiza ninguna fila.
import { create } from "zustand";

import type { LoopRowMeter, RhythmLibrary, RhythmMeterPayload } from "@libretracks/shared/models";

export type RhythmSurface = "loops" | "oneShots";
export type RhythmView = "daw" | "setlist" | "compact" | "live";
type OpenByView = Record<RhythmView, boolean>;

const OPEN_KEY = "lt.rhythm.panelOpen";
const CLOSED: OpenByView = { daw: false, setlist: false, compact: false, live: false };

function readOpenByView(): OpenByView {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    if (!raw) return { ...CLOSED };
    const parsed = JSON.parse(raw) as Partial<OpenByView>;
    return {
      daw: parsed.daw === true,
      setlist: parsed.setlist === true,
      compact: parsed.compact === true,
      live: parsed.live === true,
    };
  } catch {
    return { ...CLOSED };
  }
}

function writeOpenByView(value: OpenByView) {
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify(value));
  } catch {
    // Sin almacenamiento: se queda en memoria.
  }
}

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
  /** Panel a pantalla completa (como la letra). Sin persistir. */
  expanded: boolean;
  /** Panel abierto en cada vista (persistido, como las demás preferencias de vista). */
  openByView: OpenByView;
  setOpen: (view: RhythmView, open: boolean) => void;
  toggleOpen: (view: RhythmView) => void;
  setLibrary: (library: RhythmLibrary) => void;
  applyMeters: (payload: RhythmMeterPayload) => void;
  setSurface: (surface: RhythmSurface) => void;
  setPadEditMode: (on: boolean) => void;
  setExpanded: (expanded: boolean) => void;
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
  expanded: false,
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
  openByView: readOpenByView(),
  setOpen: (view, open) => {
    const openByView = { ...get().openByView, [view]: open };
    set({ openByView });
    writeOpenByView(openByView);
  },
  toggleOpen: (view) => get().setOpen(view, !get().openByView[view]),
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
  setExpanded: (expanded) => set({ expanded }),
  reset: () => {
    rhythmStepRef.step = -1;
    rhythmStepRef.bar = 0;
    rhythmStepRef.playing = false;
    set({ ...INITIAL, openByView: { ...CLOSED } });
    writeOpenByView(CLOSED);
  },
}));

/** El botón Ritmo se ilumina con el loop sonando o algún pad vivo. */
export function selectRhythmActive(state: Pick<RhythmStore, "loopPlaying" | "oneShotsActive">): boolean {
  return state.loopPlaying || state.oneShotsActive !== 0;
}
