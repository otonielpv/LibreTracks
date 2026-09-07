const STORAGE_KEY = "lt:mobile:liveSettingsOpen";
const ACTION_BAR_KEY = "lt:mobile:selectionBarOpen";

/**
 * Si el grupo "Directo" de la barra queda abierto o cerrado, entre arranques.
 *
 * Persiste a proposito: hay quien usa la vista DAW para TOCAR en directo, y
 * obligarle a abrir el grupo cada vez que arranca la app seria cambiar un
 * estorbo por otro. Quien toca lo deja abierto y no vuelve a pelearse con el;
 * quien esta montando lo deja cerrado y recupera el ancho.
 *
 * Cerrado por defecto: en una sesion nueva, esos ajustes son inutiles antes de
 * tener una pista y desconcertantes para un novato.
 */
export function readLiveSettingsOpen(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Modo privado / almacenamiento desactivado: cerrado, como el defecto.
    return false;
  }
}

export function persistLiveSettingsOpen(open: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Sin almacenamiento el estado vive solo en memoria; la sesion actual
    // sigue funcionando igual.
  }
}

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
