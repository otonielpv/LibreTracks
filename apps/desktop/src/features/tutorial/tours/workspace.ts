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
 * panel aparece y los pasos siguientes explican lo que tiene delante, botón a
 * botón. Un panel cerrado descrito de memoria no se recuerda igual.
 *
 * Las tres vistas se recorren de verdad: cada paso cambia a la suya (`viewMode`)
 * y cuenta para qué sirve, en vez de describirlas en un párrafo desde la DAW. El
 * overlay devuelve al usuario a la vista en la que estaba al terminar.
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
      id: "libraryImport",
      target: TOUR_TARGETS.libraryImport,
      i18nKey: "tutorial.workspace.steps.libraryImport",
    },
    {
      id: "libraryFolders",
      target: TOUR_TARGETS.libraryNewFolder,
      i18nKey: "tutorial.workspace.steps.libraryFolders",
    },
    {
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
      // Las tres voces auxiliares de la barra superior. Van cada una por su
      // lado porque hacen cosas distintas y se enrutan por separado, que es
      // justo lo que hay que entender antes del primer ensayo.
      id: "metronome",
      target: TOUR_TARGETS.topbarMetronome,
      i18nKey: "tutorial.workspace.steps.metronome",
    },
    {
      id: "voiceGuide",
      target: TOUR_TARGETS.topbarVoiceGuide,
      i18nKey: "tutorial.workspace.steps.voiceGuide",
    },
    {
      id: "pads",
      target: TOUR_TARGETS.topbarPads,
      i18nKey: "tutorial.workspace.steps.pads",
    },
    {
      // Las tres vistas, una por paso y cambiando de verdad a cada una. El
      // selector existe en las tres: en DAW y Compacta lo pinta la barra de
      // herramientas, y en Live la propia vista.
      id: "viewDaw",
      target: TOUR_TARGETS.viewModeSwitcher,
      viewMode: "daw",
      i18nKey: "tutorial.workspace.steps.viewDaw",
    },
    {
      id: "viewCompact",
      target: TOUR_TARGETS.viewModeSwitcher,
      viewMode: "compact",
      i18nKey: "tutorial.workspace.steps.viewCompact",
    },
    {
      id: "viewLive",
      target: TOUR_TARGETS.viewModeSwitcher,
      viewMode: "live",
      i18nKey: "tutorial.workspace.steps.viewLive",
    },
    {
      // Vuelve a la DAW antes de seguir: el resto del recorrido señala la barra
      // superior y el rail, y se leen mejor con el montaje delante.
      // El menú ARCHIVO no se dibuja en móvil: guardar, importar y exportar
      // viven en el rail lateral.
      id: "fileMenu",
      target: TOUR_TARGETS.topbarFileMenu,
      viewMode: "daw",
      platforms: ["desktop"],
      i18nKey: "tutorial.workspace.steps.fileMenu",
    },
    {
      id: "fileActionsMobile",
      target: TOUR_TARGETS.sideNavSessions,
      viewMode: "daw",
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
