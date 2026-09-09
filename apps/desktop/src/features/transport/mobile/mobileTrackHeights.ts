import { TRACK_HEIGHT_MAX, TRACK_HEIGHT_MIN } from "../constants";

/**
 * The four row densities offered by the touch UI. A short, predictable ladder
 * is easier to operate with a finger than the desktop's continuous 8 px steps.
 */
export const MOBILE_TRACK_HEIGHT_STOPS = [
  TRACK_HEIGHT_MIN,
  76,
  108,
  TRACK_HEIGHT_MAX,
] as const;

/** Mobile deliberately ignores desktop-only per-row offsets without deleting them. */
export function uniformMobileTrackRows<T extends { id: string }>(
  tracks: readonly T[],
): Array<{ id: string }> {
  return tracks.map(({ id }) => ({ id }));
}

/** Move exactly one stop in the direction requested by a legacy height input. */
export function resolveMobileTrackHeightChange(
  currentHeight: number,
  requestedHeight: number,
): number {
  if (requestedHeight > currentHeight) {
    return (
      MOBILE_TRACK_HEIGHT_STOPS.find((height) => height > currentHeight) ??
      MOBILE_TRACK_HEIGHT_STOPS.at(-1)!
    );
  }

  if (requestedHeight < currentHeight) {
    return (
      [...MOBILE_TRACK_HEIGHT_STOPS]
        .reverse()
        .find((height) => height < currentHeight) ?? MOBILE_TRACK_HEIGHT_STOPS[0]
    );
  }

  return MOBILE_TRACK_HEIGHT_STOPS.reduce((nearest, height) =>
    Math.abs(height - currentHeight) < Math.abs(nearest - currentHeight)
      ? height
      : nearest,
  );
}
