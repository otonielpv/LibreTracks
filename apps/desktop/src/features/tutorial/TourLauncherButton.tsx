import { useTranslation } from "react-i18next";

import { useSongStore } from "../transport/songStore";
import { tourIdForContext } from "./tourModel";
import { useTourStore } from "./tourStore";
import { TOURS } from "./tours";
import { TOUR_TARGETS } from "./tourTargets";

/**
 * Botón GUÍA del rail lateral.
 *
 * Lanza el recorrido que corresponde a lo que hay en pantalla: en la pantalla
 * de inicio, cómo crear o abrir una sesión; con la sesión abierta, el área de
 * trabajo. El `title` nombra cuál va a salir, para que el cambio no sea una
 * sorpresa al pulsar.
 *
 * Habla con el store de la guía directamente en vez de recibir un handler por
 * props. Así `TransportPanelContent` no gana ni una línea de estado ni de
 * lógica por esta feature: `SideNav` monta el botón y se acabó.
 */
export function TourLauncherButton() {
  const { t } = useTranslation();
  const startTour = useTourStore((state) => state.startTour);
  const hasOpenSession = useSongStore((state) => state.song !== null);

  const tourId = tourIdForContext(hasOpenSession);
  const tourName = t(`${TOURS[tourId].i18nKey}.name`);

  return (
    <button
      type="button"
      data-lt-tour={TOUR_TARGETS.sideNavHelp}
      aria-label={t("tutorial.launchAria", { tour: tourName })}
      title={t("tutorial.launchAria", { tour: tourName })}
      onClick={() => startTour(tourId)}
    >
      <span className="material-symbols-outlined">school</span>
      {t("tutorial.launch")}
    </button>
  );
}
