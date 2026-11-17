import type {
  SongRegionSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";

/**
 * Speed a song up or down from the Warp popover (RegionTempoControl).
 * Lives outside TransportPanelContent per the monolith rule: the monolith
 * instantiates it once with `useMemo` and only passes it down.
 *
 * The region comes in with each call (the toolbar already holds it), so the
 * factory has no volatile state and is never re-created.
 */
export type RegionTempoHandlerDeps = {
  runAction: (action: () => Promise<void>) => Promise<void>;
  refreshSongView: (options?: {
    sync?: boolean;
  }) => Promise<SongView | null>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setSongRegionTempo: (
    regionId: string,
    bpm: number,
  ) => Promise<TransportSnapshot>;
  onWarpEnabled: () => void;
  setStatus: (message: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

export function createRegionTempoHandler(deps: RegionTempoHandlerDeps) {
  return function handleRegionTempoChange(
    region: SongRegionSummary,
    nextBpm: number,
  ) {
    if (!Number.isFinite(nextBpm)) return;
    const wasWarped = region.warpEnabled;
    void deps.runAction(async () => {
      const nextSnapshot = await deps.setSongRegionTempo(region.id, nextBpm);
      if (!wasWarped) deps.onWarpEnabled();
      // Same as the warp toggle: the new ratio changes every clip's audible
      // length, so the SongView is refetched before applying the snapshot.
      await deps.refreshSongView({ sync: true });
      deps.applyPlaybackSnapshot(nextSnapshot);
      deps.setStatus(
        deps.t("transport.status.regionTempoUpdated", {
          name: region.name,
          bpm: Math.round(nextBpm * 100) / 100,
        }),
      );
    });
  };
}
