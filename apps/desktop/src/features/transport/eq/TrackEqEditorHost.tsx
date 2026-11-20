import { useEffect, useMemo } from "react";

import { createSpectrumFeed } from "@libretracks/shared/eq/spectrumFeed";

import type { TransportSnapshot } from "@libretracks/shared/models";

import {
  commitSongMasterEqChange,
  commitTrackEqChange,
  commitTrackEqsChange,
  deleteEqPreset,
  getTrackEqSpectrum,
  isGuestMirrorMode,
  listEqPresets,
  listenToEqSpectrum,
  saveEqPreset,
  setTrackEqAnalyzer,
  updateSongMasterEqRealtime,
  updateTrackEqRealtime,
} from "../desktopApi";
import { getSong, setSong, useSongStore } from "../songStore";
import { createTrackEqHandlers, trackTakesEq } from "../tracks/trackEqHandlers";
import { TrackEqEditor } from "./TrackEqEditor";
import { createSongMasterEqHandlers } from "./songMasterEqHandlers";
import { useTrackEqStore } from "./trackEqStore";

/** Último RTA del anfitrión (solo en modo invitado). */
const spectrumFeed = createSpectrumFeed();

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
        // Un invitado de red pinta el RTA del anfitrión por evento: su
        // motor no suena (plan track-eq-2, paso 07).
        getTrackEqSpectrum: (trackId) =>
          isGuestMirrorMode() ? Promise.resolve(spectrumFeed.read(trackId)) : getTrackEqSpectrum(),
        listEqPresets,
        saveEqPreset,
        deleteEqPreset,
      }),
    [runAction, applyPlaybackSnapshot, optimisticallyAppliedRevisionsRef],
  );
  const masterHandlers = useMemo(
    () =>
      createSongMasterEqHandlers({
        runAction,
        setSong,
        applyPlaybackSnapshot,
        optimisticallyAppliedRevisionsRef,
        updateSongMasterEqRealtime,
        commitSongMasterEqChange,
      }),
    [runAction, applyPlaybackSnapshot, optimisticallyAppliedRevisionsRef],
  );
  const openMasterRegionId = useTrackEqStore((state) => state.openMasterRegionId);
  const masterRegion = useSongStore((state) =>
    openMasterRegionId
      ? (state.song?.regions.find((region) => region.id === openMasterRegionId) ?? null)
      : null,
  );
  const openTrackId = useTrackEqStore((state) => state.openTrackId);
  useEffect(() => {
    if (!openTrackId || !isGuestMirrorMode()) return;
    let dispose: (() => void) | null = null;
    let active = true;
    void listenToEqSpectrum((event) => spectrumFeed.push(event))
      .then((unlisten) => {
        if (active) dispose = unlisten;
        else unlisten();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      dispose?.();
      spectrumFeed.clear();
    };
  }, [openTrackId]);
  const track = useSongStore((state) =>
    openTrackId ? (state.song?.tracks.find((candidate) => candidate.id === openTrackId) ?? null) : null,
  );
  // EQ de máster de una canción (plan track-eq-2, paso 09): el mismo editor.
  if (masterRegion) {
    return (
      <TrackEqEditor
        key={`master-${masterRegion.id}`}
        track={{ id: masterRegion.id, name: masterRegion.name, eq: masterRegion.master?.eq ?? null }}
        handlers={masterHandlers}
        midiLearn={false}
      />
    );
  }
  if (!track || !trackTakesEq(track)) return null;
  return <TrackEqEditor key={track.id} track={track} handlers={handlers} />;
}
