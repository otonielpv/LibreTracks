import { useCallback, useRef } from "react";

import { getTransportSnapshot } from "@libretracks/shared/desktopApi";
import type { TransportSnapshot } from "@libretracks/shared/models";

import { useLyricsStatus } from "./hooks/useLyricsStatus";
import "./lyrics.css";

type Props = {
  /** Folds a snapshot into the transport (re-reads the song view when the
   * project revision moved). */
  applyPlaybackSnapshot: (snapshot: TransportSnapshot) => void;
};

/**
 * Everything lyrics the transport mounts: the status feed (and, from step
 * 08, the panels every view opens). The transport only mounts this; no
 * lyrics state or logic lives there.
 */
export function LyricsRoot({ applyPlaybackSnapshot }: Props) {
  const applyRef = useRef(applyPlaybackSnapshot);
  applyRef.current = applyPlaybackSnapshot;
  const refreshSong = useCallback(() => {
    void getTransportSnapshot()
      .then((snapshot) => applyRef.current(snapshot))
      .catch(() => {});
  }, []);
  useLyricsStatus(refreshSong);
  return null;
}
