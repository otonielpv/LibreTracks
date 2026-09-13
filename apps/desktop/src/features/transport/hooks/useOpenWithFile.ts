import { useEffect, useRef } from "react";

import {
  isTauriApp,
  listenToOpenWithFile,
  takePendingOpenWithFile,
} from "../desktopApi";
import { dispatchOpenWithFile, type OpenWithDeps } from "../openWithFile";

/**
 * Abrir la app haciendo doble click en uno de sus ficheros.
 *
 * Las cuatro extensiones (`.ltsession`, `.ltset`, `.ltpkg`, `.lttemplate`) están
 * asociadas a LibreTracks en el sistema; el backend recoge el fichero y lo
 * entrega por uno de dos caminos según cuándo llegue (ver
 * `commands/open_with.rs`). Este hook cubre los dos y los manda al mismo
 * despacho.
 *
 * El orden importa: primero se registra el oyente y solo después se reclama el
 * pendiente. Reclamarlo es lo que le dice al backend que ya hay interfaz, así
 * que hacerlo antes abriría una ventana en la que un fichero recién llegado se
 * emitiría sin nadie escuchando.
 */
export function useOpenWithFile(deps: OpenWithDeps) {
  // Las dependencias se leen en el momento del despacho, no cuando se montó el
  // oyente: `hasOpenSession` y los manejadores vienen del cuerpo del componente
  // y cambian en cada render, mientras que la suscripción vive todo el proceso.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    let unlisten: (() => void) | null = null;
    // El montaje doble de StrictMode en desarrollo cancela el primer pase antes
    // de que llegue a reclamar el pendiente, así que el fichero lo recoge
    // (una sola vez) el segundo.
    let cancelled = false;

    void (async () => {
      try {
        const dispose = await listenToOpenWithFile((file) => {
          dispatchOpenWithFile(file, depsRef.current);
        });
        if (cancelled) {
          dispose();
          return;
        }
        unlisten = dispose;

        const pending = await takePendingOpenWithFile();
        if (pending && !cancelled) {
          dispatchOpenWithFile(pending, depsRef.current);
        }
      } catch {
        // Un arranque sin fichero es el caso normal; que falle el puente no
        // puede impedir que la app se use.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
