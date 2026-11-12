import type { ViewMode } from "./uiStore";

/**
 * La vista con la que arranca la app es una preferencia de la instalación,
 * como el tamaño de la interfaz: vive en localStorage, no en el proyecto.
 */
const DEFAULT_VIEW_MODE_STORAGE_KEY = "lt.defaultViewMode";

const VIEW_MODES: readonly ViewMode[] = ["daw", "setlist", "compact", "live"];

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "string" && (VIEW_MODES as readonly string[]).includes(value);
}

export function readStoredDefaultViewMode(fallback: ViewMode): ViewMode {
  try {
    const raw = window.localStorage.getItem(DEFAULT_VIEW_MODE_STORAGE_KEY);
    return isViewMode(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function storeDefaultViewMode(viewMode: ViewMode): void {
  try {
    window.localStorage.setItem(DEFAULT_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Sin almacenamiento (modo privado, cuota): la preferencia no persiste.
  }
}
