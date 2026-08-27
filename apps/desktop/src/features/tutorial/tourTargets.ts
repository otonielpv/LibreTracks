// Anclajes que la guía puede iluminar.
//
// La guía apunta a la UI REAL, no a capturas: cada id de aquí tiene que estar
// renderizado como `data-lt-tour={TOUR_TARGETS.loQueSea}` en algún sitio de la
// app. Ese acoplamiento es el precio de que la guía enseñe el botón de verdad,
// y también su punto débil: si alguien mueve o borra el botón, el anclaje se va
// con él y la guía se quedaría apuntando al vacío en silencio.
//
// Por eso `tourSteps.test.ts` escanea las fuentes buscando el atributo y lo
// cruza con los pasos: el fallo sale en CI, no en el escenario de un usuario.
//
// Los anclajes `landing*` viven por duplicado —en la pantalla vacía de
// escritorio y en `MobileLanding`— porque son dos componentes distintos para la
// misma pantalla. Nunca están montados a la vez (`isMobileApp` decide), así que
// `findTourTarget` siempre encuentra el que toca.

export const TOUR_TARGETS = {
  // Rail lateral (presente con y sin sesión abierta).
  sideNavHelp: "side-nav-help",
  sideNavSessions: "side-nav-sessions",
  sideNavLibrary: "side-nav-library",
  sideNavSettings: "side-nav-settings",
  sideNavRemote: "side-nav-remote",
  // Pantalla de inicio, sin sesión.
  landingCreate: "landing-create",
  landingOpen: "landing-open",
  landingImport: "landing-import",
  landingImportExternal: "landing-import-external",
  landingCatalog: "landing-catalog",
  // Área de trabajo, con sesión abierta.
  libraryPanel: "library-panel",
  libraryNewFolder: "library-new-folder",
  libraryImport: "library-import",
  settingsModal: "settings-modal",
  settingsClose: "settings-close",
  topbarFileMenu: "topbar-file-menu",
  topbarTransport: "topbar-transport",
  topbarMetronome: "topbar-metronome",
  topbarVoiceGuide: "topbar-voice-guide",
  topbarPads: "topbar-pads",
  timelineCanvas: "timeline-canvas",
  timelineRuler: "timeline-ruler",
  trackHeaders: "track-headers",
  mobileTouchControls: "mobile-touch-controls",
  mobileTrackReorder: "mobile-track-reorder",
  topbarTempo: "topbar-tempo",
  topbarTimeSignature: "topbar-time-signature",
  toolbarSnap: "toolbar-snap",
  toolbarVamp: "toolbar-vamp",
  toolbarMarkerJump: "toolbar-marker-jump",
  toolbarSongJump: "toolbar-song-jump",
  toolbarMaster: "toolbar-master",
  toolbarTranspose: "toolbar-transpose",
  toolbarWarp: "toolbar-warp",
  viewModeSwitcher: "view-mode-switcher",
} as const;

export type TourTargetKey = keyof typeof TOUR_TARGETS;
export type TourTargetId = (typeof TOUR_TARGETS)[TourTargetKey];

export const TOUR_TARGET_ATTRIBUTE = "data-lt-tour";

/**
 * El primer elemento con ese anclaje, o null si no está en pantalla.
 *
 * Que devuelva null es normal y esperado: hay anclajes que solo existen en una
 * plataforma (SESIONES en móvil, Remote en escritorio). El paso se dibuja
 * centrado, sin foco, en vez de romperse.
 */
export function findTourTarget(target: TourTargetId): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(
    `[${TOUR_TARGET_ATTRIBUTE}="${target}"]`,
  );
}
