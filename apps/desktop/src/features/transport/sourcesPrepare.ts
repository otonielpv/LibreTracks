import type { SourceReadinessSummary } from "@libretracks/shared/models";

/** UI state for the global "Preparing audio…" indicator. `active` is debounced
 * (only flips true after a short delay) so an already-cached project — which
 * prepares in well under that delay — never flashes the indicator. */
export type SourcesPrepareUiState = {
  active: boolean;
  percent: number;
  readyCount: number;
  total: number;
  failedCount: number;
};

export const SOURCES_PREPARE_INITIAL: SourcesPrepareUiState = {
  active: false,
  percent: 0,
  readyCount: 0,
  total: 0,
  failedCount: 0,
};

/** Delay before the indicator becomes visible. Preparations that finish faster
 * than this never show anything (no flicker on cache-warm projects). */
export const SOURCES_SHOW_DELAY_MS = 180;

/** True when the engine is actively preparing sources (something to show). */
export function deriveSourcesPreparing(
  sources: SourceReadinessSummary | null | undefined,
): boolean {
  return !!sources && sources.sourcesTotal > 0 && !sources.sourcesReady;
}

/** Build the live UI numbers from a readiness summary (no `active` decision —
 * the caller owns visibility via the debounce). */
export function sourcesUiNumbers(
  sources: SourceReadinessSummary,
): Omit<SourcesPrepareUiState, "active"> {
  return {
    percent: Math.max(0, Math.min(100, sources.sourcesProgressPercent)),
    readyCount: sources.sourcesReadyCount,
    total: sources.sourcesTotal,
    failedCount: sources.sourcesFailedCount,
  };
}

/** Reducer for a snapshot update when the indicator is NOT yet visible vs
 * already visible:
 * - not preparing -> clear `active` (and the caller cancels any pending timer)
 * - preparing & already active -> refresh the live numbers, stay active
 * - preparing & not active -> leave inactive here; the caller's debounce timer
 *   is what eventually flips `active` true (via `activateFromSources`).
 */
export function nextSourcesPrepareUiState(
  prev: SourcesPrepareUiState,
  sources: SourceReadinessSummary | null | undefined,
): SourcesPrepareUiState {
  if (!deriveSourcesPreparing(sources)) {
    return prev.active ? { ...prev, active: false } : prev;
  }
  if (prev.active) {
    return { active: true, ...sourcesUiNumbers(sources!) };
  }
  return prev;
}

/** Produce the visible state when the debounce timer fires and prep is still in
 * flight. Returns null if prep already finished (don't show a stale indicator). */
export function activateFromSources(
  sources: SourceReadinessSummary | null | undefined,
): SourcesPrepareUiState | null {
  if (!deriveSourcesPreparing(sources)) {
    return null;
  }
  return { active: true, ...sourcesUiNumbers(sources!) };
}
