/**
 * The non-modal indicator of a non-blocking song import (`.ltpkg`, Reaper/
 * Ableton project). `message` is the phase the backend is in; without it the
 * indicator falls back to "Descomprimiendo paquete…".
 */
export type PackageUnpackUiState = {
  active: boolean;
  percent: number;
  message?: string;
};

export const PACKAGE_UNPACK_IDLE: PackageUnpackUiState = { active: false, percent: 0 };

/**
 * The import itself reports 5–50%: decompress, copy, merge. Past that the
 * events belong to "Preparando audio…", and while songs are imported one
 * after another that is the PREVIOUS import's decode still running: taken
 * here it made the bar jump and the label say something about another song.
 */
const IMPORT_BAND_MAX_PERCENT = 50;

/** Fold one `project:load-progress` event into the indicator. */
export function nextPackageUnpackState(
  prev: PackageUnpackUiState,
  event: { percent: number; message: string },
): PackageUnpackUiState {
  if (!prev.active || event.percent > IMPORT_BAND_MAX_PERCENT) return prev;
  // Monotonic: a late event from an earlier phase must not move it back.
  if (event.percent < prev.percent) return prev;
  const message = event.message.trim() || prev.message;
  if (event.percent === prev.percent && message === prev.message) return prev;
  return { active: true, percent: event.percent, message };
}
