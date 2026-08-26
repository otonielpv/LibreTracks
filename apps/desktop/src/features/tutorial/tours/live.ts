import type { TourDefinition } from "../tourModel";
import { TOUR_TARGETS } from "../tourTargets";

/**
 * "Preparar el directo": los controles que deciden cómo se comporta el
 * transporte cuando ya no puedes mirar el ordenador.
 *
 * Todos viven en la barra de herramientas del timeline, que sólo se dibuja
 * fuera de la vista Live (allí la propia vista trae los suyos), así que los
 * pasos fuerzan la vista DAW. Es coherente con lo que enseñan: esto se
 * configura antes del concierto, no durante.
 */
export const liveTour: TourDefinition = {
  id: "live",
  i18nKey: "tutorial.live",
  steps: [
    {
      id: "intro",
      viewMode: "daw",
      i18nKey: "tutorial.live.steps.intro",
    },
    {
      id: "markerJump",
      target: TOUR_TARGETS.toolbarMarkerJump,
      viewMode: "daw",
      i18nKey: "tutorial.live.steps.markerJump",
    },
    {
      id: "songJump",
      target: TOUR_TARGETS.toolbarSongJump,
      viewMode: "daw",
      i18nKey: "tutorial.live.steps.songJump",
    },
    {
      id: "vamp",
      target: TOUR_TARGETS.toolbarVamp,
      viewMode: "daw",
      i18nKey: "tutorial.live.steps.vamp",
    },
    {
      id: "master",
      target: TOUR_TARGETS.toolbarMaster,
      viewMode: "daw",
      i18nKey: "tutorial.live.steps.master",
    },
    {
      id: "transpose",
      target: TOUR_TARGETS.toolbarTranspose,
      viewMode: "daw",
      i18nKey: "tutorial.live.steps.transpose",
    },
    {
      id: "warp",
      target: TOUR_TARGETS.toolbarWarp,
      viewMode: "daw",
      i18nKey: "tutorial.live.steps.warp",
    },
    {
      id: "done",
      target: TOUR_TARGETS.sideNavHelp,
      viewMode: "daw",
      i18nKey: "tutorial.live.steps.done",
    },
  ],
};
