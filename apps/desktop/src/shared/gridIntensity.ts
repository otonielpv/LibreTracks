import { useSyncExternalStore } from "react";

// Intensidad de la linea de la rejilla del timeline (estilo Live: Opciones >
// Tema > Intensidad de la linea de la rejilla). Preferencia visual por equipo,
// como el zoom de interfaz: va en localStorage, no en AppSettings.
//
// Es un multiplicador de la opacidad base de las lineas de compas y de beat:
// 0 las oculta, 1 es el valor por defecto y 2 las deja al doble.

const STORAGE_KEY = "lt.ui.gridIntensity";

export const GRID_INTENSITY_MIN = 0;
export const GRID_INTENSITY_MAX = 2;
export const GRID_INTENSITY_DEFAULT = 1;
export const GRID_INTENSITY_STEP = 0.05;

const clamp = (value: number): number =>
  Math.min(GRID_INTENSITY_MAX, Math.max(GRID_INTENSITY_MIN, value));

const readStored = (): number => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return GRID_INTENSITY_DEFAULT;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : GRID_INTENSITY_DEFAULT;
  } catch {
    return GRID_INTENSITY_DEFAULT;
  }
};

let current =
  typeof window === "undefined" ? GRID_INTENSITY_DEFAULT : readStored();
const listeners = new Set<() => void>();

export function getGridIntensity(): number {
  return current;
}

export function setGridIntensity(value: number): void {
  if (!Number.isFinite(value)) return;
  // Redondeo al paso para no guardar 0.30000000000000004.
  const next = clamp(Math.round(value / GRID_INTENSITY_STEP) * GRID_INTENSITY_STEP);
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Almacenamiento desactivado: se queda en memoria.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useGridIntensity(): number {
  return useSyncExternalStore(subscribe, getGridIntensity, getGridIntensity);
}

/** Solo para tests. */
export function resetGridIntensityForTests(): void {
  current = readStored();
  listeners.forEach((listener) => listener());
}
