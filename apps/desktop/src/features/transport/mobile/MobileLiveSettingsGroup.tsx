import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { isMobileApp } from "../desktopApi";
import {
  persistLiveSettingsOpen,
  readLiveSettingsOpen,
} from "./liveSettingsGroup";

type MobileLiveSettingsGroupProps = {
  children: ReactNode;
};

/**
 * Recoge los ajustes de DIRECTO —vamp, salto de marca, transicion entre
 * canciones y master— bajo un solo grupo plegable en movil.
 *
 * Por que: en una sesion nueva ocupan todo el ancho superior de la pantalla y
 * son inutiles antes de tener una pista; para un novato, ademas,
 * desconcertantes.
 *
 * Por que plegable y no escondido: hay quien usa la vista DAW para TOCAR. Los
 * ajustes tienen que seguir estando, y abierto ofrece exactamente los mismos
 * controles de siempre —aqui no se recorta nada, solo se pliega—. El estado
 * sobrevive a cerrar la app, asi que quien toca lo deja abierto una vez.
 *
 * En escritorio no cambia nada: devuelve sus hijos tal cual, sin envoltorio.
 */
export function MobileLiveSettingsGroup({
  children,
}: MobileLiveSettingsGroupProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(readLiveSettingsOpen);

  if (!isMobileApp) {
    return <>{children}</>;
  }

  return (
    <div className={`lt-mobile-live-group ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="lt-mobile-live-group-toggle"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          persistLiveSettingsOpen(next);
        }}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          {open ? "expand_less" : "expand_more"}
        </span>
        {t("mobileLiveSettings.title", { defaultValue: "Directo" })}
      </button>
      {open ? children : null}
    </div>
  );
}
