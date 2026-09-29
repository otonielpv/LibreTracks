// Punto de entrada al cierre guardado de la app desde cualquier parte de la
// interfaz (ARCHIVO > Salir). AppCloseGuard se registra aqui al montarse; la X
// de la ventana llega por su propio evento del backend.

let handler: (() => void) | null = null;

export function registerAppCloseHandler(next: () => void): () => void {
  handler = next;
  return () => {
    if (handler === next) {
      handler = null;
    }
  };
}

/** Guarda la sesion, avisa de que esta guardada y cierra la app. */
export function requestAppClose(): void {
  handler?.();
}
