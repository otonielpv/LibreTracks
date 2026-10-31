import type { TourDefinition } from "../tourModel";
import { TOUR_TARGETS } from "../tourTargets";

/**
 * La vista Setlist, para quien entra por primera vez (plan setlist-view, paso
 * 19): la fila de canciones, el mapa de secciones, el mezclador y Editar.
 *
 * Todos los pasos fuerzan la vista Setlist. En el teléfono el mezclador y la
 * onda se turnan, así que el paso cuyo anclaje no esté en pantalla se dibuja
 * centrado, como en los demás recorridos.
 */
export const setlistTour: TourDefinition = {
  id: "setlist",
  i18nKey: "tutorial.setlist",
  steps: [
    {
      id: "intro",
      viewMode: "setlist",
      i18nKey: "tutorial.setlist.steps.intro",
    },
    {
      id: "songs",
      target: TOUR_TARGETS.setlistSongs,
      viewMode: "setlist",
      i18nKey: "tutorial.setlist.steps.songs",
    },
    {
      id: "map",
      target: TOUR_TARGETS.setlistMap,
      viewMode: "setlist",
      i18nKey: "tutorial.setlist.steps.map",
    },
    {
      id: "keys",
      target: TOUR_TARGETS.setlistMap,
      viewMode: "setlist",
      platforms: ["desktop"],
      i18nKey: "tutorial.setlist.steps.keys",
      shortcut: "setlist.confirmJump",
    },
    {
      id: "mixer",
      target: TOUR_TARGETS.setlistMixer,
      viewMode: "setlist",
      i18nKey: "tutorial.setlist.steps.mixer",
    },
    {
      id: "edit",
      target: TOUR_TARGETS.setlistEdit,
      viewMode: "setlist",
      i18nKey: "tutorial.setlist.steps.edit",
    },
    {
      id: "done",
      target: TOUR_TARGETS.sideNavHelp,
      viewMode: "setlist",
      i18nKey: "tutorial.setlist.steps.done",
    },
  ],
};
