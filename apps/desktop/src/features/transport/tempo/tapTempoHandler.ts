import {
  getEffectiveBpmAt,
  type SongView,
  type TempoMarkerSummary,
  type TransportSnapshot,
} from "@libretracks/shared/models";

import { calculateTapTempoBpm, nextTapTempoTimes } from "../tapTempo";

export const MIN_SESSION_BPM = 20;
export const MAX_SESSION_BPM = 300;

/**
 * Dependencies for the tap-tempo handler extracted from TransportPanelContent.
 * The pure tap-timing math (nextTapTempoTimes / calculateTapTempoBpm) already
 * lives in ../tapTempo; this factory wires it to the live song, the tap-times
 * ref and the persistence path.
 *
 * `getSong` and `getCursorSeconds` are getters so the handler reads the live
 * playhead position (mutated per-frame on displayPositionSecondsRef) without
 * forcing the factory to be re-created.
 */
export type TapTempoHandlerDeps = {
  getSong: () => SongView | null;
  getCursorSeconds: () => number;
  tapTempoTimesRef: { current: number[] };
  tempoDraftDirtyRef: { current: boolean };
  setTempoDraft: (draft: string) => void;
  setStatus: (message: string) => void;
  runAction: (action: () => Promise<void>) => Promise<void>;
  refreshSongView: (options?: {
    sync?: boolean;
    includeWaveforms?: boolean;
  }) => Promise<SongView | null>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
  getEffectiveTempoMarkerAt: (
    song: SongView,
    positionSeconds: number,
  ) => TempoMarkerSummary | null;
  upsertSongTempoMarker: (
    sourceStartSeconds: number,
    bpm: number,
  ) => Promise<TransportSnapshot>;
  updateSongTempo: (bpm: number) => Promise<TransportSnapshot>;
  t: (key: string, options?: Record<string, unknown>) => string;
  now: () => number;
};

export function createTapTempoHandler(deps: TapTempoHandlerDeps) {
  const {
    getSong,
    getCursorSeconds,
    tapTempoTimesRef,
    tempoDraftDirtyRef,
    setTempoDraft,
    setStatus,
    runAction,
    refreshSongView,
    applyPlaybackSnapshot,
    optimisticallyAppliedRevisionsRef,
    getEffectiveTempoMarkerAt,
    upsertSongTempoMarker,
    updateSongTempo,
    t,
    now,
  } = deps;

  return function handleTapTempo() {
    const song = getSong();
    if (!song) {
      tapTempoTimesRef.current = [];
      return;
    }

    const nextTapTimes = nextTapTempoTimes(tapTempoTimesRef.current, now());
    tapTempoTimesRef.current = nextTapTimes;

    const tappedBpm = calculateTapTempoBpm(nextTapTimes);
    if (tappedBpm === null) {
      setStatus(t("transport.status.tapTempoWaiting"));
      return;
    }

    const clampedBpm = Math.max(
      MIN_SESSION_BPM,
      Math.min(MAX_SESSION_BPM, tappedBpm),
    );
    const nextBpm = Math.round(clampedBpm * 10) / 10;
    tempoDraftDirtyRef.current = false;
    setTempoDraft(nextBpm.toFixed(1));

    const tempoPositionSeconds = getCursorSeconds();
    const currentBpm = getEffectiveBpmAt(song, tempoPositionSeconds);
    const tempoMarker = getEffectiveTempoMarkerAt(song, tempoPositionSeconds);

    if (Math.abs(nextBpm - currentBpm) < 0.05) {
      setStatus(
        t("transport.status.tapTempoUpdated", { bpm: nextBpm.toFixed(1) }),
      );
      return;
    }

    void runAction(async () => {
      const nextSnapshot = tempoMarker
        ? await upsertSongTempoMarker(
            tempoMarker.sourceStartSeconds ?? tempoMarker.startSeconds,
            nextBpm,
          )
        : await updateSongTempo(nextBpm);
      optimisticallyAppliedRevisionsRef.current.add(
        nextSnapshot.projectRevision,
      );
      await refreshSongView({ includeWaveforms: false, sync: true });
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        t("transport.status.tapTempoUpdated", { bpm: nextBpm.toFixed(1) }),
      );
    });
  };
}
