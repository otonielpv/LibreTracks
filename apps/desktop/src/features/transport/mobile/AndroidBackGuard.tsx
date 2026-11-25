import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { isAndroidApp } from "../desktopApi";
import { useTransportStore } from "../store";
import { createBackGuard } from "./backNavigation";

declare global {
  interface Window {
    __ltHandleBack?: () => boolean;
  }
}

/**
 * Instala el guardián del botón atrás y pinta su aviso de salida.
 *
 * Un componente y no un hook suelto porque el aviso tiene que ir a algún sitio
 * del árbol; así el monolito pone una línea y no se entera de nada más. Ver
 * `backNavigation.ts` para el porqué del mecanismo.
 *
 * **Sólo Android.** Escritorio no tiene botón atrás de sistema y iOS tampoco.
 */
export function AndroidBackGuard() {
  const { t } = useTranslation();
  const [exitHintVisible, setExitHintVisible] = useState(false);

  useEffect(() => {
    if (!isAndroidApp || typeof window === "undefined") {
      return () => {};
    }

    const guard = createBackGuard({
      isPlaying: () =>
        useTransportStore.getState().playback?.playbackState === "playing",
      setExitHintVisible,
    });

    // MainActivity llama a esto en cada pulsación de atrás (ver
    // `backNavigation.ts`); `false` = que la app salga.
    window.__ltHandleBack = () => guard.handleBack();

    return () => {
      delete window.__ltHandleBack;
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
