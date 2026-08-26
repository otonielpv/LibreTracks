import type { TourDefinition } from "../tourModel";
import { TOUR_TARGETS } from "../tourTargets";

/**
 * Recorrido de la PANTALLA DE INICIO: lo que se ve antes de abrir nada.
 *
 * Aquí no hay línea de tiempo, ni pistas, ni vistas — solo la tarjeta de
 * bienvenida con sus acciones. Así que el recorrido no las menciona: ilumina
 * los botones que el usuario tiene delante, uno a uno, y termina apuntando al
 * propio botón GUÍA para contar que el recorrido cambia cuando haya una sesión
 * abierta.
 *
 * Los anclajes `landing*` existen tanto en la pantalla vacía de escritorio como
 * en `MobileLanding`, así que los mismos pasos valen en las dos plataformas; lo
 * que cambia es el texto (`bodyMobile`), porque el móvil pide el nombre y la
 * carpeta antes de crear.
 */
export const landingTour: TourDefinition = {
  id: "landing",
  i18nKey: "tutorial.landing",
  steps: [
    {
      id: "welcome",
      i18nKey: "tutorial.landing.steps.welcome",
    },
    {
      id: "create",
      target: TOUR_TARGETS.landingCreate,
      i18nKey: "tutorial.landing.steps.create",
    },
    {
      id: "open",
      target: TOUR_TARGETS.landingOpen,
      i18nKey: "tutorial.landing.steps.open",
    },
    {
      id: "import",
      target: TOUR_TARGETS.landingImport,
      i18nKey: "tutorial.landing.steps.import",
    },
    {
      // Solo escritorio: `MobileLanding` no ofrece este flujo.
      id: "importExternal",
      target: TOUR_TARGETS.landingImportExternal,
      platforms: ["desktop"],
      i18nKey: "tutorial.landing.steps.importExternal",
    },
    {
      id: "catalog",
      target: TOUR_TARGETS.landingCatalog,
      i18nKey: "tutorial.landing.steps.catalog",
    },
    {
      // El rail está disponible ya en la pantalla de inicio, y configurar la
      // salida de audio antes de montar nada ahorra el susto del primer ensayo.
      id: "audio",
      target: TOUR_TARGETS.sideNavSettings,
      i18nKey: "tutorial.landing.steps.audio",
    },
    {
      id: "next",
      target: TOUR_TARGETS.sideNavHelp,
      i18nKey: "tutorial.landing.steps.next",
    },
  ],
};
