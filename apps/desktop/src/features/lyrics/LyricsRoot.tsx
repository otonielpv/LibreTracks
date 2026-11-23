import { useCallback, useRef } from "react";

import { getTransportSnapshot } from "@libretracks/shared/desktopApi";
import type { TransportSnapshot } from "@libretracks/shared/models";

import { ChartImportHost } from "../chartSources/ChartImportHost";
import { PlanImportHost } from "../chartSources/PlanImportHost";
import { ChartEditorHost } from "../transport/charts/ChartEditorHost";
import { useLyricsStatus } from "./hooks/useLyricsStatus";
import { LyricsSetlistLinker } from "./LyricsSetlistLinker";
import { LyricsSongPanel } from "./LyricsSongPanel";
import { useLyricsStore } from "./lyricsStore";
import "./lyrics.css";

type Props = {
  /** Folds a snapshot into the transport (re-reads the song view when the
   * project revision moved). */
  applyPlaybackSnapshot: (snapshot: TransportSnapshot) => void;
};

/**
 * Everything lyrics the transport mounts: the status feed and the two
 * panels every view opens (DAW, Setlist, Compact and mobile reach them from
 * the same song menu), plus the lyrics-and-chords editor, mounted here so it
 * survives the Live/Setlist panel remounting when a phone turns to portrait. The transport only mounts this; no lyrics state or
 * logic lives there.
 */
export function LyricsRoot({ applyPlaybackSnapshot }: Props) {
  const applyRef = useRef(applyPlaybackSnapshot);
  applyRef.current = applyPlaybackSnapshot;
  const onSnapshot = useCallback((snapshot: unknown) => {
    if (snapshot) applyRef.current(snapshot as TransportSnapshot);
  }, []);
  const refreshSong = useCallback(() => {
    void getTransportSnapshot()
      .then((snapshot) => applyRef.current(snapshot))
      .catch(() => {});
  }, []);
  useLyricsStatus(refreshSong);
  const linkerOpen = useLyricsStore((state) => state.linkerOpen);
  const songPanelRegionId = useLyricsStore((state) => state.songPanelRegionId);
  return (
    <>
      <ChartEditorHost />
      <ChartImportHost onSnapshot={onSnapshot} />
      <PlanImportHost onSnapshot={onSnapshot} />
      {linkerOpen ? <LyricsSetlistLinker onSnapshot={onSnapshot} /> : null}
      {songPanelRegionId ? (
        <LyricsSongPanel regionId={songPanelRegionId} onSnapshot={onSnapshot} />
      ) : null}
    </>
  );
}
