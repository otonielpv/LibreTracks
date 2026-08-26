import { create } from "zustand";

import { isMobileApp } from "@libretracks/shared/desktopApi";

import { useSongStore } from "../transport/songStore";
import {
  shouldAutoContinueWorkspaceTour,
  tourIdForContext,
  visibleSteps,
  type TourId,
  type TourOutcome,
  type TourPlatform,
  type TourProgress,
  type TourStep,
} from "./tourModel";
import { TOURS } from "./tours";

// Estado de la guía interactiva.
//
// Store propio (no estado en TransportPanelContent) por la regla de CLAUDE.md:
// una feature nueva no añade estado al monolito. Como el store sobrevive al
// desmontaje, `src/test/testUtils.tsx` lo resetea en su `beforeEach`.
//
// Se persiste CÓMO terminó cada recorrido, nunca el paso en curso: una guía a
// medias que reaparece al abrir la app es más molesta que útil.

const STORAGE_KEY = "lt.tutorial.v2";
/** Formato anterior: un array de ids vistos, sin distinguir cómo acabaron. */
const LEGACY_STORAGE_KEY = "lt.tutorial.v1";

const VALID_TOUR_IDS = new Set<string>(Object.keys(TOURS));
const VALID_OUTCOMES = new Set<string>(["completed", "dismissed"]);

function readProgress(): TourProgress {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return {};
      const progress: TourProgress = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (
          VALID_TOUR_IDS.has(key) &&
          typeof value === "string" &&
          VALID_OUTCOMES.has(value)
        ) {
          progress[key as TourId] = value as TourOutcome;
        }
      }
      return progress;
    }

    // Migración desde v1: sabíamos que se habían visto, no si se terminaron.
    // Los damos por descartados, que es la lectura conservadora — como mucho
    // dejamos de ofrecer una continuación, nunca insistimos de más.
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return {};
    const parsedLegacy = JSON.parse(legacy) as unknown;
    if (!Array.isArray(parsedLegacy)) return {};
    const migrated: TourProgress = {};
    for (const value of parsedLegacy) {
      if (typeof value === "string" && VALID_TOUR_IDS.has(value)) {
        migrated[value as TourId] = "dismissed";
      }
    }
    return migrated;
  } catch {
    return {};
  }
}

function persistProgress(progress: TourProgress): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Modo privado o almacenamiento lleno: la guía sigue funcionando, solo que
    // volverá a ofrecerse en el próximo arranque.
  }
}

export function currentTourPlatform(): TourPlatform {
  return isMobileApp ? "mobile" : "desktop";
}

/**
 * El recorrido que corresponde a lo que hay en pantalla ahora mismo.
 *
 * Sin proyecto cargado el usuario está en la pantalla de inicio (la tarjeta
 * vacía de escritorio o `MobileLanding`), donde no existen ni la línea de
 * tiempo ni las vistas. `song === null` es el mismo criterio que usa el panel
 * de transporte para decidir qué pintar (`isProjectEmpty`).
 */
export function tourForCurrentContext(): TourId {
  return tourIdForContext(useSongStore.getState().song !== null);
}

type TourState = {
  activeTourId: TourId | null;
  /** Índice dentro de `steps`, no dentro de la definición del recorrido. */
  stepIndex: number;
  /**
   * Los pasos de la plataforma, resueltos UNA vez al arrancar. Guardarlos aquí
   * mantiene el store puro: `nextStep` sabe dónde termina sin volver a
   * consultar la plataforma ni la definición.
   */
  steps: TourStep[];
  progress: TourProgress;
  startTour: (tourId: TourId, platform?: TourPlatform) => void;
  /** `dismissed` por defecto: salir sin llegar al final no es terminarla. */
  endTour: (outcome?: TourOutcome) => void;
  nextStep: () => void;
  previousStep: () => void;
};

export const useTourStore = create<TourState>()((set, get) => ({
  activeTourId: null,
  stepIndex: 0,
  steps: [],
  progress: readProgress(),
  startTour: (tourId, platform = currentTourPlatform()) => {
    const tour = TOURS[tourId];
    const steps = visibleSteps(tour, platform);
    if (steps.length === 0) return;
    set({ activeTourId: tourId, stepIndex: 0, steps });
  },
  endTour: (outcome = "dismissed") => {
    const { activeTourId, progress } = get();
    const nextProgress: TourProgress = activeTourId
      ? { ...progress, [activeTourId]: outcome }
      : progress;
    if (nextProgress !== progress) {
      persistProgress(nextProgress);
    }
    set({
      activeTourId: null,
      stepIndex: 0,
      steps: [],
      progress: nextProgress,
    });
  },
  nextStep: () => {
    const { stepIndex, steps } = get();
    if (stepIndex >= steps.length - 1) {
      get().endTour("completed");
      return;
    }
    set({ stepIndex: stepIndex + 1 });
  },
  previousStep: () => {
    set((state) => ({ stepIndex: Math.max(0, state.stepIndex - 1) }));
  },
}));

export function hasSeenTour(tourId: TourId): boolean {
  return useTourStore.getState().progress[tourId] !== undefined;
}

/**
 * Continúa sola la guía del área de trabajo en cuanto se abre una sesión.
 *
 * Vive aquí y no dentro del overlay para que el cableado se pueda probar: con
 * `isTestRun` calculado en el componente, la suscripción sería letra muerta en
 * los tests y nadie comprobaría que de verdad escucha al store de canciones.
 *
 * Devuelve la función para cancelar la suscripción.
 */
export function subscribeWorkspaceContinuation(options: {
  isWebDriver: boolean;
  isTestRun: boolean;
}): () => void {
  return useSongStore.subscribe(
    (state) => state.song !== null,
    (hasSession, hadSession) => {
      // Sólo el flanco de subida: reabrir otra sesión más tarde no vuelve a
      // ofrecer nada (y `progress` ya lo impediría de todos modos).
      if (!hasSession || hadSession) return;
      const store = useTourStore.getState();
      if (
        !shouldAutoContinueWorkspaceTour({
          progress: store.progress,
          isTourActive: store.activeTourId !== null,
          isWebDriver: options.isWebDriver,
          isTestRun: options.isTestRun,
        })
      ) {
        return;
      }
      store.startTour("workspace");
    },
  );
}
