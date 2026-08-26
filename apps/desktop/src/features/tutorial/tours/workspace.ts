import type { TourDefinition } from "../tourModel";
import { TOUR_TARGETS } from "../tourTargets";

/**
 * Recorrido del ÁREA DE TRABAJO: solo tiene sentido con una sesión abierta.
 *
 * Todo lo que ilumina —biblioteca, línea de tiempo, transporte, selector de
 * vistas— existe únicamente cuando hay proyecto cargado, que es exactamente por
 * qué esto no puede vivir en el recorrido de la pantalla de inicio.
 *
 * El orden sigue el camino de trabajo real (dónde está el audio → dónde se
 * coloca → cómo se escucha → cómo se toca en directo), no el orden en que están
 * los controles en pantalla.
 */
export const workspaceTour: TourDefinition = {
  id: "workspace",
  i18nKey: "tutorial.workspace",
  steps: [
    {
      id: "overview",
      i18nKey: "tutorial.workspace.steps.overview",
    },
    {
      id: "library",
      target: TOUR_TARGETS.sideNavLibrary,
      i18nKey: "tutorial.workspace.steps.library",
    },
    {
      // Único paso que fuerza una vista: el lienzo solo existe en la DAW. El
      // overlay devuelve al usuario a su vista original al terminar.
      id: "timeline",
      target: TOUR_TARGETS.timelineCanvas,
      viewMode: "daw",
      i18nKey: "tutorial.workspace.steps.timeline",
    },
    {
      id: "transport",
      target: TOUR_TARGETS.topbarTransport,
      shortcut: "transport.playPause",
      i18nKey: "tutorial.workspace.steps.transport",
    },
    {
      id: "views",
      target: TOUR_TARGETS.viewModeSwitcher,
      i18nKey: "tutorial.workspace.steps.views",
    },
    {
      // El menú ARCHIVO no se dibuja en móvil: guardar, importar y exportar
      // viven en el rail lateral.
      id: "fileMenu",
      target: TOUR_TARGETS.topbarFileMenu,
      platforms: ["desktop"],
      i18nKey: "tutorial.workspace.steps.fileMenu",
    },
    {
      id: "fileActionsMobile",
      target: TOUR_TARGETS.sideNavSessions,
      platforms: ["mobile"],
      i18nKey: "tutorial.workspace.steps.fileActionsMobile",
    },
    {
      id: "settings",
      target: TOUR_TARGETS.sideNavSettings,
      i18nKey: "tutorial.workspace.steps.settings",
    },
    {
      id: "remote",
      target: TOUR_TARGETS.sideNavRemote,
      platforms: ["desktop"],
      i18nKey: "tutorial.workspace.steps.remote",
    },
    {
      id: "done",
      target: TOUR_TARGETS.sideNavHelp,
      i18nKey: "tutorial.workspace.steps.done",
    },
  ],
};
