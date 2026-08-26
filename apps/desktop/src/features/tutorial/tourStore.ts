import { create } from "zustand";

import { isMobileApp } from "@libretracks/shared/desktopApi";

import { useSongStore } from "../transport/songStore";
import {
  tourIdForContext,
  visibleSteps,
  type TourId,
  type TourPlatform,
  type TourStep,
} from "./tourModel";
import { TOURS } from "./tours";

// Estado de la guía interactiva.
//
// Store propio (no estado en TransportPanelContent) por la regla de CLAUDE.md:
// una feature nueva no añade estado al monolito. Como el store sobrevive al
// desmontaje, `src/test/testUtils.tsx` lo resetea en su `beforeEach`.
//
// Solo se persiste QUÉ recorridos se han visto, nunca el paso en curso: una
// guía a medias que reaparece al abrir la app es más molesta que útil.

const STORAGE_KEY = "lt.tutorial.v1";

const VALID_TOUR_IDS = new Set<string>(Object.keys(TOURS));

function readSeenTours(): TourId[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Filtramos por ids conocidos para no arrastrar un blob viejo de una
    // versión que tuviera otros recorridos.
    return parsed.filter(
      (value): value is TourId =>
        typeof value === "string" && VALID_TOUR_IDS.has(value),
    );
  } catch {
    return [];
  }
}

function persistSeenTours(seenTours: readonly TourId[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seenTours));
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
  seenTours: TourId[];
  startTour: (tourId: TourId, platform?: TourPlatform) => void;
  endTour: () => void;
  nextStep: () => void;
  previousStep: () => void;
};

export const useTourStore = create<TourState>()((set, get) => ({
  activeTourId: null,
  stepIndex: 0,
  steps: [],
  seenTours: readSeenTours(),
  startTour: (tourId, platform = currentTourPlatform()) => {
    const tour = TOURS[tourId];
    const steps = visibleSteps(tour, platform);
    if (steps.length === 0) return;
    set({ activeTourId: tourId, stepIndex: 0, steps });
  },
  endTour: () => {
    const { activeTourId, seenTours } = get();
    const nextSeen =
      activeTourId && !seenTours.includes(activeTourId)
        ? [...seenTours, activeTourId]
        : seenTours;
    if (nextSeen !== seenTours) {
      persistSeenTours(nextSeen);
    }
    set({ activeTourId: null, stepIndex: 0, steps: [], seenTours: nextSeen });
  },
  nextStep: () => {
    const { stepIndex, steps } = get();
    if (stepIndex >= steps.length - 1) {
      get().endTour();
      return;
    }
    set({ stepIndex: stepIndex + 1 });
  },
  previousStep: () => {
    set((state) => ({ stepIndex: Math.max(0, state.stepIndex - 1) }));
  },
}));

export function hasSeenTour(tourId: TourId): boolean {
  return useTourStore.getState().seenTours.includes(tourId);
}
