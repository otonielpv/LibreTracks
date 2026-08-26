import type { TourDefinition, TourId } from "../tourModel";
import { dawTour } from "./daw";
import { landingTour } from "./landing";
import { liveTour } from "./live";
import { workspaceTour } from "./workspace";

/**
 * Registro de recorridos. `toursForContext` decide cuáles se ofrecen en cada
 * pantalla; esto es sólo el catálogo.
 */
export const TOURS: Record<TourId, TourDefinition> = {
  landing: landingTour,
  workspace: workspaceTour,
  daw: dawTour,
  live: liveTour,
};
