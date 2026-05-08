import { useEffect } from "react";
import { isTauriApp, listenToAudioMeters } from "../desktopApi";
import { meterDictionaryFromLevels, useTransportStore } from "../store";

export function useAudioMeters() {
  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }

    let active = true;
    let unlisten: (() => void) | undefined;
    let frameId: number | null = null;
    let pendingMeters: ReturnType<typeof meterDictionaryFromLevels> | null =
      null;

    const flushMeters = () => {
      frameId = null;
      if (!active || pendingMeters === null) {
        return;
      }

      useTransportStore.getState().setMeters(pendingMeters);
      pendingMeters = null;
    };

    void listenToAudioMeters((levels) => {
      if (!active) {
        return;
      }

      pendingMeters = meterDictionaryFromLevels(levels);
      if (frameId === null) {
        frameId = window.requestAnimationFrame(flushMeters);
      }
    }).then((nextUnlisten) => {
      if (!active) {
        nextUnlisten();
        return;
      }

      unlisten = nextUnlisten;
    });

    return () => {
      active = false;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      pendingMeters = null;
      unlisten?.();
    };
  }, []);
}
