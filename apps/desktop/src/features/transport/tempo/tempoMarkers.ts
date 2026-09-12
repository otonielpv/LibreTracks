import type { SongView, TempoMarkerSummary } from "@libretracks/shared/models";

/**
 * The tempo marker in effect at a position — the latest one at or before it.
 *
 * Pure and component-free, which is why it lives here rather than in
 * TransportPanelContent: `tapTempoHandler` already takes it as an injected
 * dependency, so the monolith was only holding it by accident of history.
 *
 * The 1 ms slack matches a marker the playhead is sitting exactly on, which
 * floating-point positions otherwise miss by a hair.
 */
export function getEffectiveTempoMarkerAt(
  song: SongView | null | undefined,
  positionSeconds: number,
): TempoMarkerSummary | null {
  if (!song?.tempoMarkers.length) return null;
  let bestMarker: TempoMarkerSummary | null = null;
  for (const marker of song.tempoMarkers) {
    if (
      marker.startSeconds <= positionSeconds + 0.001 &&
      (!bestMarker || marker.startSeconds > bestMarker.startSeconds)
    ) {
      bestMarker = marker;
    }
  }
  return bestMarker;
}
