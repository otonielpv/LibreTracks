import type {
  SongView,
  TrackEq,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import { useTrackEqStore } from "../eq/trackEqStore";
import { defaultTrackEq, sanitizeTrackEq } from "../eq/trackEqModel";

/**
 * Acciones del ecualizador por pista (plan track-eq, D9/D12). Es la ÚNICA
 * definición de cada una: la cabecera DAW, Compacta, Setlist y el móvil abren
 * el editor y confirman por aquí, nunca con su propia copia.
 *
 * Patrón de las demás factories del transporte: dependencias inyectadas, el
 * estado vivo (la pista actual) se lee con getters para que la factory se
 * cree una vez con `useMemo` y siga viendo valores frescos.
 *
 * - `applyLive`: el arrastre; solo motor, sin modelo ni deshacer. Quien
 *   arrastra lo limita a un envío por frame.
 * - `commit`: al soltar; modelo + un paso de deshacer + motor, con el EQ
 *   recortado igual que el core. Parchea la canción en el acto para que todas
 *   las vistas vean el cambio sin esperar al siguiente snapshot.
 */
export type TrackEqHandlerDeps = {
  runAction: (action: () => Promise<void>) => Promise<void>;
  setSong: (update: (previous: SongView | null) => SongView | null) => void;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
  findTrack: (trackId: string) => TrackSummary | null;
  updateTrackEqRealtime: (args: { trackId: string; eq: TrackEq | null }) => Promise<void>;
  commitTrackEqChange: (args: {
    trackId: string;
    eq: TrackEq | null;
  }) => Promise<TransportSnapshot>;
};

export type TrackEqHandlers = ReturnType<typeof createTrackEqHandlers>;

export function createTrackEqHandlers(deps: TrackEqHandlerDeps) {
  const {
    runAction,
    setSong,
    applyPlaybackSnapshot,
    optimisticallyAppliedRevisionsRef,
    findTrack,
    updateTrackEqRealtime,
    commitTrackEqChange,
  } = deps;

  const open = (trackId: string) => {
    const track = findTrack(trackId);
    if (!track || track.kind !== "audio") return;
    useTrackEqStore.getState().setOpenTrackId(trackId);
  };

  const close = () => useTrackEqStore.getState().setOpenTrackId(null);

  const applyLive = (trackId: string, eq: TrackEq | null) => {
    void updateTrackEqRealtime({ trackId, eq: eq ? sanitizeTrackEq(eq) : null }).catch(
      () => undefined,
    );
  };

  const commit = async (trackId: string, eq: TrackEq | null) => {
    const clean = eq ? sanitizeTrackEq(eq) : null;
    await runAction(async () => {
      const snapshot = await commitTrackEqChange({ trackId, eq: clean });
      optimisticallyAppliedRevisionsRef.current.add(snapshot.projectRevision);
      setSong((previous) =>
        previous
          ? {
              ...previous,
              projectRevision: snapshot.projectRevision,
              tracks: previous.tracks.map((candidate) =>
                candidate.id === trackId ? { ...candidate, eq: clean } : candidate,
              ),
            }
          : previous,
      );
      applyPlaybackSnapshot(snapshot);
    });
  };

  /** Bypass global: apaga/enciende el EQ entero; sin EQ, crea uno apagado. */
  const toggleBypass = (trackId: string) => {
    const current = findTrack(trackId)?.eq ?? defaultTrackEq();
    return commit(trackId, { ...current, enabled: !current.enabled });
  };

  /** Vuelve a las 6 bandas por defecto (D2). */
  const reset = (trackId: string) => commit(trackId, defaultTrackEq());

  /** Quita el EQ de la pista (vuelve a no tener, coste cero en el motor). */
  const remove = (trackId: string) => commit(trackId, null);

  return { open, close, applyLive, commit, toggleBypass, reset, remove };
}
