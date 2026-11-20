import type { TrackEqEditorHandlers } from "@libretracks/shared/eq/TrackEqEditor";
import { defaultTrackEq, sanitizeTrackEq } from "@libretracks/shared/eq/trackEqModel";
import type { SongView, TrackEq, TransportSnapshot } from "@libretracks/shared/models";

import { useTrackEqStore } from "./trackEqStore";

/**
 * Acciones del EQ de máster de una canción (plan track-eq-2, E10): el mismo
 * editor que el EQ de pista, sobre `region.master.eq`. El "id de pista" que
 * el editor pasa es el id de la región.
 *
 * - `applyLive`: solo motor (arrastre), sin modelo ni deshacer.
 * - `commit`: modelo + un paso de deshacer + motor, y la canción parcheada en
 *   el acto para que el popover y el editor no esperen al snapshot.
 * - Sin RTA: el analizador es por pista.
 */
export type SongMasterEqHandlerDeps = {
  runAction: (action: () => Promise<void>) => Promise<void>;
  setSong: (update: (previous: SongView | null) => SongView | null) => void;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
  updateSongMasterEqRealtime: (args: { regionId: string; eq: TrackEq | null }) => Promise<void>;
  commitSongMasterEqChange: (args: {
    regionId: string;
    eq: TrackEq | null;
  }) => Promise<TransportSnapshot>;
};

export function openSongMasterEq(regionId: string | null) {
  useTrackEqStore.getState().setOpenMasterRegionId(regionId);
}

export function createSongMasterEqHandlers(deps: SongMasterEqHandlerDeps): TrackEqEditorHandlers {
  const commit = async (regionId: string, eq: TrackEq | null) => {
    const clean = eq ? sanitizeTrackEq(eq) : null;
    await deps.runAction(async () => {
      const snapshot = await deps.commitSongMasterEqChange({ regionId, eq: clean });
      deps.optimisticallyAppliedRevisionsRef.current.add(snapshot.projectRevision);
      deps.setSong((previous) =>
        previous
          ? {
              ...previous,
              projectRevision: snapshot.projectRevision,
              regions: previous.regions.map((region) =>
                region.id === regionId
                  ? { ...region, master: { ...region.master, eq: clean } }
                  : region,
              ),
            }
          : previous,
      );
      deps.applyPlaybackSnapshot(snapshot);
    });
  };
  return {
    close: () => openSongMasterEq(null),
    applyLive: (regionId, eq) => {
      void deps
        .updateSongMasterEqRealtime({ regionId, eq: eq ? sanitizeTrackEq(eq) : null })
        .catch(() => undefined);
    },
    commit,
    reset: (regionId) => commit(regionId, defaultTrackEq()),
    remove: async (regionId) => {
      await commit(regionId, null);
      openSongMasterEq(null);
    },
    startAnalyzer: () => undefined,
    stopAnalyzer: () => undefined,
    readSpectrum: () => Promise.resolve([]),
  };
}
