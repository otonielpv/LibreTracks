import {
  formatBpm,
  type SongView,
  type TempoMarkerSummary,
  type TransportSnapshot,
} from "@libretracks/shared/models";

import { setSongTempoMarkerRamp } from "../desktopApi";
import { formatClock } from "../helpers";
import type { ContextMenuAction } from "../types";

export type TempoRampActionDeps = {
  t: (key: string, options?: Record<string, unknown>) => string;
  song: SongView | null;
  runAction: (work: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
};

/** The tempo marker right after `marker`, the one a ramp from it ends on. */
export function nextTempoMarker(
  song: SongView | null,
  marker: TempoMarkerSummary,
): TempoMarkerSummary | null {
  return (
    (song?.tempoMarkers ?? [])
      .filter((other) => other.startSeconds > marker.startSeconds + 1e-6)
      .sort((a, b) => a.startSeconds - b.startSeconds)[0] ?? null
  );
}

/**
 * The tempo marker's "ramp to the next marker" toggle, as Ableton's sloped
 * tempo-automation segment. With no marker after it there is nothing to ramp
 * to, so it is offered disabled (unless already on, to turn it off).
 */
export function tempoRampAction(
  marker: TempoMarkerSummary,
  deps: TempoRampActionDeps,
): ContextMenuAction {
  const { t } = deps;
  const next = nextTempoMarker(deps.song, marker);
  const ramp = marker.ramp === true;
  return {
    label: next
      ? t("transport.menu.tempoRamp", { from: formatBpm(marker.bpm), to: formatBpm(next.bpm) })
      : t("transport.menu.tempoRampNoNext"),
    swatch: ramp ? "var(--lt-accent)" : undefined,
    disabled: !next && !ramp,
    onSelect: async () => {
      await deps.runAction(async () => {
        const snapshot = await setSongTempoMarkerRamp(marker.id, !ramp);
        deps.applyPlaybackSnapshot(snapshot);
        deps.setStatus(
          t(ramp ? "transport.status.tempoRampOff" : "transport.status.tempoRampOn", {
            time: formatClock(marker.startSeconds),
          }),
        );
      });
    },
  };
}
