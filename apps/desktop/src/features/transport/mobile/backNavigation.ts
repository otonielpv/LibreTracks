/**
 * El botón atrás de Android cierra primero lo que esté abierto.
 *
 * ## El problema
 *
 * El atrás por defecto de Tauri (`WryActivity.kt`, autogenerado): si el
 * WebView puede navegar atrás, navega; si no, termina la actividad. Con un
 * modal o un panel delante, eso significa **salir de la aplicación**, que en
 * mitad de un ensayo es caro.
 *
 * ## Cómo se arregla
 *
 * `MainActivity` apaga ese atrás (`handleBackNavigation = false`) y pregunta a
 * la página con `window.__ltHandleBack()`: si devuelve `true`, la página lo ha
 * gastado (cerró algo o enseñó el aviso); si no, sale como siempre.
 *
 * Antes se hacía sin Kotlin, con entradas de historial de mentira
 * (`pushState`) que el atrás consumía. No aguantaba: Chromium marca como
 * «saltables» las entradas añadidas sin un gesto del usuario, y el WebView se
 * las salta al ir atrás. La que se reponía tras cerrar un overlay (la tecla
 * atrás no es un gesto) o la de un panel abierto al arrancar se saltaban, y
 * el atrás cerraba la app con el panel delante.
 *
 * ## Confirmación al salir
 *
 * Con reproducción en curso, el primer toque sin nada abierto no sale: enseña
 * un aviso. El segundo, mientras se ve el aviso, sí sale. Es el patrón «pulsa
 * atrás otra vez para salir» de toda la vida en Android, y **no mata el
 * proceso**: la actividad termina como siempre.
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
  /** ¿Está sonando el transporte ahora mismo? */
  isPlaying: () => boolean;
  /** Enseña/quita el aviso «pulsa atrás otra vez para salir». */
  setExitHintVisible: (visible: boolean) => void;
};

/** Cuánto dura el aviso antes de volver a proteger la salida. */
export const EXIT_HINT_MS = 2500;

/**
 * La decisión de cada pulsación, separada de Android para poder probarla.
 * `handleBack` devuelve `true` si la página gastó la pulsación y `false` si
 * la app debe salir.
 */
export function createBackGuard(host: BackGuardHost) {
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const hideHint = () => {
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    host.setExitHintVisible(false);
  };

  const handleBack = (): boolean => {
    if (disposed) {
      return false;
    }
    const { stack, unregister } = useBackDismissStore.getState();
    const top = stack[stack.length - 1];
    if (top) {
      hideHint();
      unregister(top.id);
      top.close();
      return true;
    }

    if (hintTimer === null && host.isPlaying()) {
      // Nada abierto pero sonando: el primer toque avisa, no sale.
      host.setExitHintVisible(true);
      hintTimer = setTimeout(() => {
        hintTimer = null;
        host.setExitHintVisible(false);
      }, EXIT_HINT_MS);
      return true;
    }

    // Nada abierto y nada sonando, o segundo toque con el aviso: que salga.
    hideHint();
    return false;
  };

  return {
    handleBack,
    dispose: () => {
      disposed = true;
      if (hintTimer !== null) {
        clearTimeout(hintTimer);
        hintTimer = null;
      }
    },
  };
}
