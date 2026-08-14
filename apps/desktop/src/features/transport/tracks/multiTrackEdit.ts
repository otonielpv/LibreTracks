import {
  DB_FLOOR,
  dbToGain,
  gainToDb,
} from "@libretracks/shared/faderScale";

/**
 * Multi-track editing — applying one strip's edit to the whole selection.
 *
 * When several tracks are selected, acting on any control of a track *inside*
 * that selection applies to every selected track, the way Ableton Live does it.
 * Two different rules, because the controls mean different things:
 *
 *   • **Toggles** (mute / solo / transpose) and **routing** are *absolute*:
 *     every selected track is set to the value the clicked track just took, so
 *     one click can't leave the selection in a half-on/half-off state.
 *   • **Faders** (volume / pan) are *relative*: the delta the dragged track
 *     moved is applied to each selected track, preserving the balance between
 *     them. Volume's delta is measured in **dB**, not linear gain, so a "+3 dB"
 *     nudge is the same perceptual step on a quiet track as on a loud one.
 *
 * Acting on a track that is *not* in the selection is always a single-track
 * edit and leaves the selection alone — same rule the track drag already uses
 * in ./trackHandlers.
 */

/**
 * The tracks an edit on `trackId` should apply to.
 *
 * Returns the whole selection when `trackId` is part of a multi-selection, and
 * just `[trackId]` otherwise (single selection, or a track outside it).
 */
export function resolveEditTargets(
  trackId: string,
  selectedTrackIds: readonly string[],
): string[] {
  if (selectedTrackIds.length > 1 && selectedTrackIds.includes(trackId)) {
    return [...selectedTrackIds];
  }
  return [trackId];
}

/** True when the edit fans out to more than the originating track. */
export function isMultiEdit(
  trackId: string,
  selectedTrackIds: readonly string[],
): boolean {
  return resolveEditTargets(trackId, selectedTrackIds).length > 1;
}

/**
 * Shift a linear gain by `deltaDb` decibels, clamped to `[0, maxGain]`.
 *
 * A track already at silence (gain 0 / −∞ dB) stays silent: there is no finite
 * dB value to add to, and Ableton likewise leaves a fader parked at −inf alone
 * until you drag *it*. A positive delta on such a track would otherwise have to
 * invent a starting point.
 */
export function offsetGainByDb(
  gain: number,
  deltaDb: number,
  maxGain: number,
): number {
  if (gain <= 0) {
    return 0;
  }
  const nextDb = gainToDb(gain) + deltaDb;
  if (nextDb <= DB_FLOOR) {
    return 0;
  }
  return Math.min(maxGain, dbToGain(nextDb));
}

/**
 * The dB delta a volume edit represents, given the dragged track's previous and
 * next linear gains.
 *
 * Returns `null` when the delta can't be expressed in dB — the dragged track
 * came from, or landed on, silence. Callers fall back to an absolute set for
 * the dragged track only, because "×0" or "÷0" has no meaningful group offset.
 */
export function volumeDeltaDb(
  previousGain: number,
  nextGain: number,
): number | null {
  if (previousGain <= 0 || nextGain <= 0) {
    return null;
  }
  return gainToDb(nextGain) - gainToDb(previousGain);
}
