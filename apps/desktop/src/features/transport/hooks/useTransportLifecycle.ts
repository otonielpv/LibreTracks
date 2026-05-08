import { useEffect, useRef, type MutableRefObject } from "react";
import type { TransportSnapshot } from "@libretracks/shared/models";
import {
  getTransportSnapshot,
  isTauriApp,
  listenToTransportLifecycle,
} from "../desktopApi";
import type { TransportAnchorMeta } from "../types";

function transportSnapshotKey(snapshot: TransportSnapshot): string {
  return [
    snapshot.playbackState,
    snapshot.positionSeconds.toFixed(6),
    snapshot.transportClock?.anchorPositionSeconds?.toFixed(6) ?? "none",
    snapshot.transportClock?.running ? "1" : "0",
    String(snapshot.projectRevision),
  ].join("|");
}

type UseTransportLifecycleProps = {
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  transportAnchorMetaRef: MutableRefObject<TransportAnchorMeta | null>;
  setStatus: (status: string) => void;
  t: (key: string) => string;
};

export function useTransportLifecycle({
  applyPlaybackSnapshot,
  transportAnchorMetaRef,
  setStatus,
  t,
}: UseTransportLifecycleProps) {
  const callbacksRef = useRef({ setStatus, t });

  useEffect(() => {
    callbacksRef.current = { setStatus, t };
  });

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    async function loadSnapshot() {
      const nextSnapshot = await getTransportSnapshot();
      if (!active) {
        return;
      }

      applyPlaybackSnapshot(nextSnapshot);
      callbacksRef.current.setStatus(
        nextSnapshot.isNativeRuntime
          ? callbacksRef.current.t("transport.status.readyDesktop")
          : callbacksRef.current.t("transport.status.readyDemo"),
      );
    }

    void loadSnapshot();

    if (!isTauriApp) {
      return () => {
        active = false;
      };
    }

    void listenToTransportLifecycle((event) => {
      if (!active) {
        return;
      }

      transportAnchorMetaRef.current = {
        snapshotKey: transportSnapshotKey(event.snapshot),
        anchorPositionSeconds: event.anchorPositionSeconds,
        emittedAtUnixMs: event.emittedAtUnixMs,
      };
      applyPlaybackSnapshot(event.snapshot);
    }).then((nextUnlisten) => {
      if (!active) {
        nextUnlisten();
        return;
      }

      unlisten = nextUnlisten;
    });

    return () => {
      active = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyPlaybackSnapshot]);
}
