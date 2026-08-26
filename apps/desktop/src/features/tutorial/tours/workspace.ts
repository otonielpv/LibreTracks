import type { TourDefinition } from "../tourModel";
import { TOUR_TARGETS } from "../tourTargets";

/**
 * Recorrido del ÁREA DE TRABAJO: solo tiene sentido con una sesión abierta.
 *
 * Todo lo que ilumina —biblioteca, línea de tiempo, transporte, selector de
 * vistas— existe únicamente cuando hay proyecto cargado, que es exactamente por
 * qué esto no puede vivir en el recorrido de la pantalla de inicio.
 *
 * La biblioteca y los ajustes se enseñan ABRIÉNDOLOS: el usuario pulsa, el
 * panel aparece y el paso siguiente explica lo que tiene delante. Un panel
 * cerrado descrito de memoria no se recuerda igual que uno abierto.
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
      id: "openLibrary",
      target: TOUR_TARGETS.sideNavLibrary,
      waitFor: { target: TOUR_TARGETS.libraryPanel },
      i18nKey: "tutorial.workspace.steps.openLibrary",
    },
    {
      // El panel se queda abierto durante el resto del recorrido: es una barra
      // lateral, no un modal, así que la línea de tiempo sigue a la vista.
      id: "libraryContents",
      target: TOUR_TARGETS.libraryPanel,
      i18nKey: "tutorial.workspace.steps.libraryContents",
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
      id: "openSettings",
      target: TOUR_TARGETS.sideNavSettings,
      waitFor: { target: TOUR_TARGETS.settingsModal },
      i18nKey: "tutorial.workspace.steps.openSettings",
    },
    {
      id: "settingsTour",
      target: TOUR_TARGETS.settingsModal,
      i18nKey: "tutorial.workspace.steps.settingsTour",
    },
    {
      // Hay que cerrarlo: el modal tapa el rail al que apuntan los dos últimos
      // pasos.
      id: "closeSettings",
      target: TOUR_TARGETS.settingsClose,
      waitFor: { target: TOUR_TARGETS.settingsModal, present: false },
      i18nKey: "tutorial.workspace.steps.closeSettings",
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
