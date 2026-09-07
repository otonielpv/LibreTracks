const ACTION_BAR_KEY = "lt:mobile:selectionBarOpen";

/**
 * Si la barra de acciones se ve o esta recogida, entre arranques.
 *
 * Abierta por defecto: es la respuesta a "un usuario nuevo no ve por donde
 * empezar", y recogida de fabrica no resolveria nada. Pero quien ya se sabe la
 * app la quiere fuera de en medio —ocupa el borde inferior siempre, tenga o no
 * seleccion—, y esa preferencia tiene que sobrevivir a cerrar la app o sera un
 * gesto que repetir cada dia.
 */
export function readSelectionBarOpen(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(ACTION_BAR_KEY) !== "0";
  } catch {
    return true;
  }
}

export function persistSelectionBarOpen(open: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(ACTION_BAR_KEY, open ? "1" : "0");
  } catch {
    // Sin almacenamiento vale con la sesion actual.
  }
}
