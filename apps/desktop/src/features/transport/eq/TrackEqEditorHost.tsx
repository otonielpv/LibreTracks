import { useMemo } from "react";

import type { TransportSnapshot } from "@libretracks/shared/models";

import {
  commitTrackEqChange,
  commitTrackEqsChange,
  deleteEqPreset,
  getTrackEqSpectrum,
  listEqPresets,
  saveEqPreset,
  setTrackEqAnalyzer,
  updateTrackEqRealtime,
} from "../desktopApi";
import { getSong, setSong, useSongStore } from "../songStore";
import { createTrackEqHandlers } from "../tracks/trackEqHandlers";
import { TrackEqEditor } from "./TrackEqEditor";
import { useTrackEqStore } from "./trackEqStore";

/**
 * El único sitio donde se monta el editor de EQ (plan track-eq, D12). Lo abre
 * cualquier vista con `openTrackEq`; aquí se instancia una vez la factory de
 * handlers con lo que el transporte comparte (acción con estado de error,
 * publicación del snapshot y revisiones optimistas).
 */
export function TrackEqEditorHost({
  runAction,
  applyPlaybackSnapshot,
  optimisticallyAppliedRevisionsRef,
}: {
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
}) {
  const handlers = useMemo(
    () =>
      createTrackEqHandlers({
        runAction,
        setSong,
        applyPlaybackSnapshot,
        optimisticallyAppliedRevisionsRef,
        findTrack: (trackId) => getSong()?.tracks.find((track) => track.id === trackId) ?? null,
        updateTrackEqRealtime,
        commitTrackEqChange,
        commitTrackEqsChange,
        setTrackEqAnalyzer,
        getTrackEqSpectrum,
        listEqPresets,
        saveEqPreset,
        deleteEqPreset,
      }),
    [runAction, applyPlaybackSnapshot, optimisticallyAppliedRevisionsRef],
  );
  const openTrackId = useTrackEqStore((state) => state.openTrackId);
  const track = useSongStore((state) =>
    openTrackId ? (state.song?.tracks.find((candidate) => candidate.id === openTrackId) ?? null) : null,
  );
  if (!track || track.kind !== "audio") return null;
  return <TrackEqEditor key={track.id} track={track} handlers={handlers} />;
}
