import type { TourDefinition, TourId } from "../tourModel";
import { landingTour } from "./landing";
import { workspaceTour } from "./workspace";

/**
 * Registro de recorridos, uno por contexto de pantalla. Las guías temáticas
 * (directo, automatización, pads) se añaden aquí.
 */
export const TOURS: Record<TourId, TourDefinition> = {
  landing: landingTour,
  workspace: workspaceTour,
};
