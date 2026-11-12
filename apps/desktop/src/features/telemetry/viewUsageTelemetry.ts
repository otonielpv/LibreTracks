import { isViewMode } from "../transport/defaultViewMode";
import { recordProductEvent } from "./telemetry";

/**
 * Marca la raíz del contenido de cada vista. Una vista cuenta como usada
 * cuando el usuario interactúa DENTRO de ella, no por visitarla: la app
 * arranca en una vista y contarla por eso daba la DAW siempre al 100 %.
 */
export const VIEW_USAGE_ATTRIBUTE = "data-lt-view";

/** Controles dentro de una vista que no son usarla (p. ej. el selector de vista). */
export const VIEW_USAGE_IGNORE_ATTRIBUTE = "data-lt-view-usage-ignore";

export function startViewUsageTracking(): () => void {
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(`[${VIEW_USAGE_IGNORE_ATTRIBUTE}]`)) return;
    const view = target.closest(`[${VIEW_USAGE_ATTRIBUTE}]`)?.getAttribute(VIEW_USAGE_ATTRIBUTE);
    if (isViewMode(view)) recordProductEvent(`feature_${view}_view`);
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  return () => document.removeEventListener("pointerdown", onPointerDown, true);
}
