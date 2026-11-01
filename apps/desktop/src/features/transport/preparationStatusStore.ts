import { create } from "zustand";

import {
  SOURCES_PREPARE_INITIAL,
  type SourcesPrepareUiState,
} from "./sourcesPrepare";

/**
 * Estado de los indicadores de preparación: «Preparando audio…» (fuentes y
 * apertura de proyecto) y el aviso de audio transpuesto.
 *
 * Vivía en `useState` de TransportPanelContent y cada sondeo de transporte lo
 * reescribía con un objeto nuevo aunque nada cambiara: el panel entero se
 * re-renderizaba en CADA sondeo (100 ms mientras se prepara audio, 250 ms
 * sonando). Aquí los setters descartan escrituras iguales y sólo el componente
 * de los indicadores (`PreparationIndicators`) se suscribe a los números.
 *
 * Un store sobrevive al desmontaje: se resetea en `src/test/testUtils.tsx`.
 */

export type PitchPrepareUiState = {
  active: boolean;
  message: string;
  error?: string;
  startedAt?: number;
};

export const PITCH_PREPARE_INITIAL: PitchPrepareUiState = {
  active: false,
  message: "",
};

type PreparationStatusState = {
  /** Fuentes del motor (debounced: ver sourcesPrepare.ts). */
  sources: SourcesPrepareUiState;
  /** Sin debounce: acelera el sondeo mientras haya fuentes preparándose. */
  sourcesPreparing: boolean;
  /** Apertura/importación diferida de proyecto (useProjectAudioPreparation). */
  project: SourcesPrepareUiState;
  pitch: PitchPrepareUiState;
};

type PreparationStatusStore = PreparationStatusState & {
  setSources: (
    next:
      | SourcesPrepareUiState
      | ((prev: SourcesPrepareUiState) => SourcesPrepareUiState),
  ) => void;
  setSourcesPreparing: (preparing: boolean) => void;
  setProject: (next: SourcesPrepareUiState) => void;
  setPitch: (next: PitchPrepareUiState) => void;
};

export const INITIAL_PREPARATION_STATUS: PreparationStatusState = {
  sources: SOURCES_PREPARE_INITIAL,
  sourcesPreparing: false,
  project: SOURCES_PREPARE_INITIAL,
  pitch: PITCH_PREPARE_INITIAL,
};

export function sameSourcesPrepareUiState(
  a: SourcesPrepareUiState,
  b: SourcesPrepareUiState,
) {
  return (
    a.active === b.active &&
    a.percent === b.percent &&
    a.readyCount === b.readyCount &&
    a.total === b.total &&
    a.failedCount === b.failedCount
  );
}

/** `startedAt` no cuenta: es cuándo se encendió el aviso, no su contenido. */
export function samePitchPrepareUiState(
  a: PitchPrepareUiState,
  b: PitchPrepareUiState,
) {
  return (
    a.active === b.active &&
    a.message === b.message &&
    (a.error ?? "") === (b.error ?? "")
  );
}

export const usePreparationStatusStore = create<PreparationStatusStore>()(
  (set, get) => ({
    ...INITIAL_PREPARATION_STATUS,
    setSources: (next) => {
      const prev = get().sources;
      const resolved = typeof next === "function" ? next(prev) : next;
      if (!sameSourcesPrepareUiState(prev, resolved)) {
        set({ sources: resolved });
      }
    },
    setSourcesPreparing: (preparing) => {
      if (get().sourcesPreparing !== preparing) {
        set({ sourcesPreparing: preparing });
      }
    },
    setProject: (next) => {
      if (!sameSourcesPrepareUiState(get().project, next)) {
        set({ project: next });
      }
    },
    setPitch: (next) => {
      if (!samePitchPrepareUiState(get().pitch, next)) {
        set({ pitch: next });
      }
    },
  }),
);

/** Lo que pinta «Preparando audio…»: la apertura de proyecto manda si está activa. */
export function selectAudioPreparationUiState(state: PreparationStatusState) {
  return state.project.active ? state.project : state.sources;
}
