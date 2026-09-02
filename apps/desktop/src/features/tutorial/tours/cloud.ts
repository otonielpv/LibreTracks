import type { TourDefinition } from "../tourModel";
import { TOUR_TARGETS } from "../tourTargets";

/**
 * Recorrido de la NUBE: llevar canciones y sesiones de un dispositivo a otro.
 *
 * Es el único que se ofrece en las dos pantallas, y por eso sus pasos se
 * filtran por `contexts`. La razón es que la nube no es una zona de la app sino
 * una forma de mover cosas, y sus puntos de entrada están repartidos: el botón
 * Nube vive en el inicio, mientras que exportar e importar viven dentro de la
 * sesión. Un recorrido solo para el inicio dejaría sin contar la mitad, y
 * partirlo en dos contaría lo mismo dos veces.
 *
 * También es el primero pensado como NOVEDAD y no como primeros pasos: quien ya
 * terminó el tutorial no tiene ninguna marca para este recorrido, así que se le
 * ofrece igual que a alguien nuevo. Quien en su día pulsó "Saltar" no lo verá,
 * y eso es deliberado — ya dijo que no.
 *
 * Los pasos son descriptivos y NO interactivos: exportar e importar abren un
 * diálogo del sistema o el navegador para el consentimiento de Google, y
 * empujar a pulsarlos dejaría la guía atrapada detrás de algo que no
 * controlamos. Es el mismo criterio que ya sigue el recorrido de inicio.
 */
export const cloudTour: TourDefinition = {
  id: "cloud",
  i18nKey: "tutorial.cloud",
  steps: [
    {
      id: "welcome",
      i18nKey: "tutorial.cloud.steps.welcome",
    },
    {
      id: "yourAccount",
      i18nKey: "tutorial.cloud.steps.yourAccount",
    },
    {
      id: "panel",
      target: TOUR_TARGETS.landingCloud,
      contexts: ["landing"],
      i18nKey: "tutorial.cloud.steps.panel",
    },
    {
      id: "importLanding",
      target: TOUR_TARGETS.landingImport,
      contexts: ["landing"],
      i18nKey: "tutorial.cloud.steps.importLanding",
    },
    // El menú ARCHIVO solo existe en escritorio; en móvil sus entradas viven en
    // el rail, así que el mismo paso se cuenta apuntando a otro sitio.
    {
      id: "fileMenu",
      target: TOUR_TARGETS.topbarFileMenu,
      contexts: ["session"],
      platforms: ["desktop"],
      i18nKey: "tutorial.cloud.steps.fileMenu",
    },
    {
      id: "fileActions",
      target: TOUR_TARGETS.mobileFileActions,
      contexts: ["session"],
      platforms: ["mobile"],
      i18nKey: "tutorial.cloud.steps.fileActions",
    },
    {
      id: "naming",
      i18nKey: "tutorial.cloud.steps.naming",
    },
    {
      id: "privacy",
      i18nKey: "tutorial.cloud.steps.privacy",
    },
  ],
};
