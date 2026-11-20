import type {
  EqPreset,
  SongView,
  TrackEq,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import { useTrackEqStore } from "../eq/trackEqStore";
import {
  defaultTrackEq,
  sanitizeTrackEq,
  trackKindTakesEq,
} from "@libretracks/shared/eq/trackEqModel";

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
  /** Lote con un solo paso de deshacer (plan track-eq-2, paso 02). */
  commitTrackEqsChange: (args: {
    changes: { trackId: string; eq: TrackEq | null }[];
  }) => Promise<TransportSnapshot>;
  setTrackEqAnalyzer: (trackId: string | null) => Promise<void>;
  /** RTA de `trackId`: el motor propio, o el evento del anfitrión si esto es un invitado. */
  getTrackEqSpectrum: (trackId: string) => Promise<number[]>;
  /** Presets de esta máquina (plan track-eq-2, paso 01). */
  listEqPresets: () => Promise<EqPreset[]>;
  saveEqPreset: (args: { presetId: string | null; name: string; eq: TrackEq }) => Promise<EqPreset[]>;
  deleteEqPreset: (presetId: string) => Promise<EqPreset[]>;
};

export type TrackEqHandlers = ReturnType<typeof createTrackEqHandlers>;

/** Qué pistas pueden llevar EQ. */
export function trackTakesEq(track: Pick<TrackSummary, "kind"> | null | undefined): boolean {
  return trackKindTakesEq(track?.kind);
}

/**
 * Abrir el editor de una pista. Es lo único que necesitan los botones de las
 * vistas, y no depende de nada del monolito: vive aquí para que todas llamen
 * a la misma acción. Solo pistas de audio. Con `targets` (varias pistas
 * seleccionadas), cada cambio del editor va a todas las que llevan EQ.
 */
export function openTrackEq(
  track: Pick<TrackSummary, "id" | "kind"> | null,
  targets: Pick<TrackSummary, "id" | "kind">[] = [],
) {
  if (!track || !trackTakesEq(track)) return;
  useTrackEqStore.getState().setOpenTrackId(
    track.id,
    targets.filter(trackTakesEq).map((target) => target.id),
  );
}

/**
 * Confirma un EQ en varias pistas: una sola llamada (un paso de deshacer) y
 * la canción parcheada en el acto. Con una pista usa el comando de siempre.
 * La usan el editor y la entrada «Copiar EQ» del menú contextual.
 */
export async function commitTrackEqs(
  deps: Pick<
    TrackEqHandlerDeps,
    | "runAction"
    | "setSong"
    | "applyPlaybackSnapshot"
    | "optimisticallyAppliedRevisionsRef"
    | "commitTrackEqChange"
    | "commitTrackEqsChange"
  >,
  trackIds: string[],
  eq: TrackEq | null,
) {
  const clean = eq ? sanitizeTrackEq(eq) : null;
  const ids = [...new Set(trackIds)];
  if (ids.length === 0) return;
  await deps.runAction(async () => {
    const snapshot =
      ids.length === 1
        ? await deps.commitTrackEqChange({ trackId: ids[0], eq: clean })
        : await deps.commitTrackEqsChange({
            changes: ids.map((trackId) => ({ trackId, eq: clean })),
          });
    deps.optimisticallyAppliedRevisionsRef.current.add(snapshot.projectRevision);
    const targets = new Set(ids);
    deps.setSong((previous) =>
      previous
        ? {
            ...previous,
            projectRevision: snapshot.projectRevision,
            tracks: previous.tracks.map((candidate) =>
              targets.has(candidate.id) ? { ...candidate, eq: clean } : candidate,
            ),
          }
        : previous,
    );
    deps.applyPlaybackSnapshot(snapshot);
  });
}

export function createTrackEqHandlers(deps: TrackEqHandlerDeps) {
  const {
    findTrack,
    updateTrackEqRealtime,
    setTrackEqAnalyzer,
    getTrackEqSpectrum,
    listEqPresets,
    saveEqPreset,
    deleteEqPreset,
  } = deps;

  const open = (trackId: string) => openTrackEq(findTrack(trackId));

  const close = () => useTrackEqStore.getState().setOpenTrackId(null);

  /**
   * Pistas a las que va un cambio de `trackId`: las del editor abierto si es
   * esa pista (varias seleccionadas), o solo ella.
   */
  const targetsFor = (trackId: string) => {
    const { openTrackId, targetTrackIds } = useTrackEqStore.getState();
    if (openTrackId !== trackId || targetTrackIds.length < 2) return [trackId];
    return targetTrackIds.filter((id) => trackTakesEq(findTrack(id)));
  };

  const applyLive = (trackId: string, eq: TrackEq | null) => {
    const clean = eq ? sanitizeTrackEq(eq) : null;
    for (const target of targetsFor(trackId)) {
      void updateTrackEqRealtime({ trackId: target, eq: clean }).catch(() => undefined);
    }
  };

  const commit = (trackId: string, eq: TrackEq | null) => commitTrackEqs(deps, targetsFor(trackId), eq);

  /** Copia el EQ de una pista a otras (menú contextual), un deshacer. */
  const copyTo = (sourceTrackId: string, targetTrackIds: string[]) => {
    const source = findTrack(sourceTrackId);
    if (!trackTakesEq(source)) return Promise.resolve();
    const targets = targetTrackIds.filter((id) => id !== sourceTrackId && trackTakesEq(findTrack(id)));
    return commitTrackEqs(deps, targets, source?.eq ?? null);
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

  /** RTA: el motor empieza a analizar la pista (después de su EQ). */
  const startAnalyzer = (trackId: string) => {
    void setTrackEqAnalyzer(trackId).catch(() => undefined);
  };

  /** RTA apagado: el motor deja de copiar audio. */
  const stopAnalyzer = () => {
    void setTrackEqAnalyzer(null).catch(() => undefined);
  };

  /** Bandas en dB del RTA (vacío si no hay o si falla la lectura). */
  const readSpectrum = (trackId: string) =>
    getTrackEqSpectrum(trackId).catch(() => [] as number[]);

  /** Presets: fábrica primero; vacío si falla la lectura. */
  const listPresets = () => listEqPresets();

  /** Guarda la curva con nombre (un preset nuevo). Devuelve la lista. */
  const savePreset = (name: string, eq: TrackEq) =>
    saveEqPreset({ presetId: null, name, eq: sanitizeTrackEq(eq) });

  const deletePreset = (presetId: string) => deleteEqPreset(presetId);

  return {
    open,
    close,
    applyLive,
    commit,
    copyTo,
    targetsFor,
    toggleBypass,
    reset,
    remove,
    startAnalyzer,
    stopAnalyzer,
    readSpectrum,
    listPresets,
    savePreset,
    deletePreset,
  };
}
