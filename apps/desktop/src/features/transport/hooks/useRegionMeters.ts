import { useEffect } from "react";
import { isTauriApp, listenToRegionMeters } from "../desktopApi";
import { regionMeterDictionaryFromLevels, useTransportStore } from "../store";

export function useRegionMeters() {
  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }

    let active = true;
    let unlisten: (() => void) | undefined;
    let frameId: number | null = null;
    let pending: ReturnType<typeof regionMeterDictionaryFromLevels> | null =
      null;

    const flush = () => {
      frameId = null;
      if (!active || pending === null) {
        return;
      }

      useTransportStore.getState().setRegionMeters(pending);
      pending = null;
    };

    void listenToRegionMeters((levels) => {
      if (!active) {
        return;
      }

      pending = regionMeterDictionaryFromLevels(levels);
      if (frameId === null) {
        frameId = window.requestAnimationFrame(flush);
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
      pending = null;
      unlisten?.();
    };
  }, []);
}
