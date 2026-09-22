import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { isAndroidApp } from "../desktopApi";
import { useTransportStore } from "../store";
import {
  createBackGuard,
  useBackDismissStore,
} from "./backNavigation";

/**
 * Instala el guardián del botón atrás y pinta su aviso de salida.
 *
 * Un componente y no un hook suelto porque el aviso tiene que ir a algún sitio
 * del árbol; así el monolito pone una línea y no se entera de nada más. Ver
 * `backNavigation.ts` para el porqué del mecanismo.
 *
 * **Sólo Android.** Escritorio no tiene botón atrás de sistema y iOS tampoco;
 * meterles entradas de historial sería cambiarles el comportamiento sin
 * motivo.
 */
export function AndroidBackGuard() {
  const { t } = useTranslation();
  const [exitHintVisible, setExitHintVisible] = useState(false);

  useEffect(() => {
    if (!isAndroidApp || typeof window === "undefined") {
      return () => {};
    }

    const guard = createBackGuard({
      pushEntry: () => window.history.pushState({ ltBackGuard: true }, ""),
      popEntry: () => window.history.back(),
      isPlaying: () =>
        useTransportStore.getState().playback?.playbackState === "playing",
      setExitHintVisible,
    });

    const onPopState = () => guard.handleBack();
    window.addEventListener("popstate", onPopState);

    // Rearmar cuando se abre o cierra algo, y cuando arranca o para el
    // transporte. El estado del transporte se lee del snapshot que ya publica
    // el store; no hay estado nuevo en ningun sitio.
    const unsubscribeStack = useBackDismissStore.subscribe(() => guard.sync());
    const unsubscribeTransport = useTransportStore.subscribe(() =>
      guard.sync(),
    );
    guard.sync();

    return () => {
      window.removeEventListener("popstate", onPopState);
      unsubscribeStack();
      unsubscribeTransport();
      guard.dispose();
    };
  }, []);

  if (!exitHintVisible) {
    return null;
  }

  return (
    <div className="lt-back-exit-hint" role="status">
      {t("transport.backGuard.pressAgainToExit", {
        defaultValue:
          "Se está reproduciendo. Pulsa atrás otra vez para salir.",
      })}
    </div>
  );
}
