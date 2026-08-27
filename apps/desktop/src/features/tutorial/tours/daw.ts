import type { TourDefinition } from "../tourModel";
import { TOUR_TARGETS } from "../tourTargets";

/**
 * "Montar una canción": el recorrido a fondo de la vista DAW.
 *
 * Va aparte del recorrido general del área de trabajo porque son dos cosas
 * distintas: aquel enseña DÓNDE está cada zona, y éste enseña a TRABAJAR dentro
 * de una. Juntos pasarían de treinta pasos seguidos, y nadie repasa el warp
 * tragándose antes veinte pantallas sobre la biblioteca.
 *
 * Casi todo pasa en la regla —crear canciones, redimensionarlas, moverlas,
 * poner marcas— así que varios pasos comparten anclaje y lo que cambia es lo
 * que se explica. Es deliberado: la regla es un control con muchas funciones y
 * enseñarlas de golpe en un párrafo no se retiene.
 *
 * Todos los pasos fuerzan la vista DAW: fuera de ella no existen ni la regla ni
 * el panel de pistas. El overlay devuelve al usuario a su vista al terminar.
 */
export const dawTour: TourDefinition = {
  id: "daw",
  i18nKey: "tutorial.daw",
  steps: [
    {
      id: "intro",
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.intro",
    },
    {
      id: "ruler",
      target: TOUR_TARGETS.timelineRuler,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.ruler",
    },
    {
      id: "createSong",
      target: TOUR_TARGETS.timelineRuler,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.createSong",
    },
    {
      id: "resizeSong",
      target: TOUR_TARGETS.timelineRuler,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.resizeSong",
    },
    {
      id: "moveSong",
      target: TOUR_TARGETS.timelineRuler,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.moveSong",
    },
    {
      id: "createMarker",
      target: TOUR_TARGETS.timelineRuler,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.createMarker",
    },
    {
      id: "markerKinds",
      target: TOUR_TARGETS.timelineRuler,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.markerKinds",
    },
    {
      id: "dragMarkers",
      target: TOUR_TARGETS.timelineRuler,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.dragMarkers",
    },
    {
      id: "tempo",
      target: TOUR_TARGETS.topbarTempo,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.tempo",
    },
    {
      id: "timeSignature",
      target: TOUR_TARGETS.topbarTimeSignature,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.timeSignature",
    },
    {
      id: "snap",
      target: TOUR_TARGETS.toolbarSnap,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.snap",
    },
    {
      id: "tracks",
      target: TOUR_TARGETS.trackHeaders,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.tracks",
    },
    {
      id: "folders",
      target: TOUR_TARGETS.trackHeaders,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.folders",
    },
    {
      id: "midiTracks",
      target: TOUR_TARGETS.trackHeaders,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.midiTracks",
    },
    {
      id: "automationTracks",
      target: TOUR_TARGETS.trackHeaders,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.automationTracks",
    },
    {
      // Sólo móvil: en escritorio la altura se cambia con Alt+scroll y no hay
      // riesgo de mover el cabezal con la palma de la mano.
      id: "touchControls",
      target: TOUR_TARGETS.mobileTouchControls,
      platforms: ["mobile"],
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.touchControls",
    },
    {
      id: "trackReorderMode",
      target: TOUR_TARGETS.mobileTrackReorder,
      platforms: ["mobile"],
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.trackReorderMode",
    },
    {
      id: "clips",
      target: TOUR_TARGETS.timelineCanvas,
      viewMode: "daw",
      shortcut: "edit.splitClip",
      i18nKey: "tutorial.daw.steps.clips",
    },
    {
      id: "done",
      target: TOUR_TARGETS.sideNavHelp,
      viewMode: "daw",
      i18nKey: "tutorial.daw.steps.done",
    },
  ],
};
