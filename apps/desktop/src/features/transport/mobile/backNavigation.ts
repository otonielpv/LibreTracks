/**
 * El botón atrás de Android cierra primero lo que esté abierto.
 *
 * ## El problema
 *
 * El comportamiento de atrás no es código de este repo: lo pone Tauri en
 * `WryActivity.kt`, que es autogenerado y dice `DO NOT MODIFY`. Hace dos cosas:
 * si el WebView puede navegar atrás, navega; si no, termina la actividad. Con
 * un modal o un panel delante, eso significa **salir de la aplicación**, que en
 * mitad de un ensayo es caro.
 *
 * ## Cómo se arregla sin tocar el fichero autogenerado
 *
 * Dándole al WebView historial que navegar. Mientras haya algo abierto,
 * metemos una entrada de historial de mentira (`pushState`); el botón atrás la
 * consume (`goBack`), nos llega un `popstate` y cerramos lo de arriba de la
 * pila. Si queda algo abierto, volvemos a poner la entrada.
 *
 * Esto sobrevive a un `tauri android init` porque **no hay una sola línea de
 * Kotlin**: es el camino que el propio `WryActivity` recorre primero.
 *
 * ## Confirmación al salir
 *
 * Con reproducción en curso también mantenemos la entrada puesta, así que el
 * primer toque no sale: enseña un aviso y deja de rearmarse. El segundo toque,
 * ése sí, sale. Es el patrón «pulsa atrás otra vez para salir» de toda la vida
 * en Android, y **no mata el proceso**: la actividad termina como siempre y
 * Android decide cuándo reclamar el proceso.
 *
 * ## Quién se registra
 *
 * Cada overlay lo hace por su cuenta con {@link useDismissOnBack}, en su propio
 * componente. Ni el monolito ni este módulo mantienen una lista de modales que
 * haya que acordarse de actualizar.
 */
import { useEffect, useId } from "react";
import { create } from "zustand";

/** Algo abierto que el botón atrás debe cerrar. */
type Dismissable = {
  id: string;
  close: () => void;
};

type BackDismissStore = {
  /** Pila: el último en abrirse es el primero en cerrarse. */
  stack: Dismissable[];
  register: (entry: Dismissable) => void;
  unregister: (id: string) => void;
};

export const useBackDismissStore = create<BackDismissStore>((set) => ({
  stack: [],
  register: (entry) =>
    set((state) => ({
      stack: [...state.stack.filter((item) => item.id !== entry.id), entry],
    })),
  unregister: (id) =>
    set((state) => {
      const stack = state.stack.filter((item) => item.id !== id);
      return stack.length === state.stack.length ? state : { stack };
    }),
}));

/**
 * Registra este overlay para que el botón atrás lo cierre.
 *
 * Se llama desde el componente del overlay, no desde quien lo abre: si el
 * overlay se monta sólo cuando está abierto, `enabled` puede quedarse en su
 * valor por defecto y el montaje ya es la señal.
 *
 * Fuera de Android no hace nada visible: la pila se mantiene igual, pero nadie
 * la consume porque el guardián sólo se instala en Android.
 */
export function useDismissOnBack(close: () => void, enabled = true) {
  const id = useId();
  useEffect(() => {
    if (!enabled) {
      return () => {};
    }
    // `close` se lee en el momento de cerrar, no se captura: un overlay que
    // recrea su callback en cada render no debe reordenar la pila.
    useBackDismissStore.getState().register({ id, close });
    return () => useBackDismissStore.getState().unregister(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, id]);

  // El callback más reciente gana sin tocar el orden de la pila.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const { stack, register } = useBackDismissStore.getState();
    if (stack.some((item) => item.id === id)) {
      register({ id, close });
    }
  }, [close, enabled, id]);
}

export type BackGuardHost = {
  /** Añade la entrada de historial que el botón atrás consumirá. */
  pushEntry: () => void;
  /** Quita una entrada que ya no hace falta (un `history.back()`). */
  popEntry: () => void;
  /** ¿Está sonando el transporte ahora mismo? */
  isPlaying: () => boolean;
  /** Enseña/quita el aviso «pulsa atrás otra vez para salir». */
  setExitHintVisible: (visible: boolean) => void;
};

/** Cuánto dura el aviso antes de volver a proteger la salida. */
export const EXIT_HINT_MS = 2500;

/**
 * La máquina de estados, separada de `window.history` a propósito para poder
 * probarla sin depender de cómo jsdom implementa el historial.
 */
export function createBackGuard(host: BackGuardHost) {
  let armed = false;
  /** Entradas que hemos mandado quitar y cuyo `popstate` aún no ha llegado. */
  let pendingPops = 0;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearHint = () => {
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
  };

  const needsGuard = () =>
    useBackDismissStore.getState().stack.length > 0 || host.isPlaying();

  /**
   * Pon o quita la entrada de historial según haga falta.
   *
   * `pendingPops` es lo que evita la carrera de «cierro un modal y abro otro»:
   * el `history.back()` del primero puede llegar después del `pushState` del
   * segundo, así que el `popstate` que lo trae no cierra nada y vuelve a
   * sincronizar.
   */
  const sync = () => {
    if (disposed) {
      return;
    }
    if (needsGuard()) {
      if (!armed) {
        armed = true;
        host.pushEntry();
      }
      return;
    }
    if (armed) {
      armed = false;
      pendingPops += 1;
      host.popEntry();
    }
  };

  /** El usuario ha pulsado atrás (nos llega como `popstate`). */
  const handleBack = () => {
    if (disposed) {
      return;
    }
    if (pendingPops > 0) {
      // No es el usuario: es el eco de una entrada que quitamos nosotros.
      pendingPops -= 1;
      armed = false;
      sync();
      return;
    }

    armed = false;
    clearHint();
    host.setExitHintVisible(false);

    const { stack, unregister } = useBackDismissStore.getState();
    const top = stack[stack.length - 1];
    if (top) {
      unregister(top.id);
      top.close();
      sync();
      return;
    }

    if (host.isPlaying()) {
      // Nada abierto pero sonando: el primer toque avisa, no sale. Mientras el
      // aviso esté en pantalla NO nos rearmamos, así que el segundo toque cae
      // en el comportamiento de siempre y termina la actividad.
      host.setExitHintVisible(true);
      hintTimer = setTimeout(() => {
        hintTimer = null;
        host.setExitHintVisible(false);
        sync();
      }, EXIT_HINT_MS);
      return;
    }

    // Nada abierto y nada sonando: que salga, como hasta ahora.
  };

  return {
    sync,
    handleBack,
    dispose: () => {
      disposed = true;
      clearHint();
    },
    /** Sólo para los tests. */
    isArmed: () => armed,
  };
}
