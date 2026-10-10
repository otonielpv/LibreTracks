import { useEffect } from "react";

import {
  getGuestSnapshot,
  getHostStatus,
  listenToGuestStatus,
  listenToHostStatus,
} from "@libretracks/shared/networkApi";
import { isTauriApp } from "@libretracks/shared/desktopApi";

import { useNetworkSessionStore } from "./networkSessionStore";

/**
 * Follows the backend's network-session events into the store. Mounted once,
 * by `NetworkSessionRoot`. Reads the current state after subscribing, so a
 * session resumed at startup (keep hosting after restart) shows up too.
 */
export function useNetworkSessionEvents() {
  useEffect(() => {
    if (!isTauriApp) return () => {};
    const store = useNetworkSessionStore.getState();
    let disposed = false;
    const disposers: Array<() => void> = [];
    const keep = (promise: Promise<() => void>) => {
      void promise
        .then((dispose) => {
          if (disposed) dispose();
          else disposers.push(dispose);
        })
        .catch(() => {});
    };

    keep(listenToHostStatus(store.setHost));
    keep(listenToGuestStatus(store.setGuest));

    void getHostStatus()
      .then((host) => {
        if (!disposed) store.setHost(host);
      })
      .catch(() => {});
    void getGuestSnapshot()
      .then((snapshot) => {
        if (!disposed) store.applyGuestSnapshot(snapshot);
      })
      .catch(() => {});

    return () => {
      disposed = true;
      for (const dispose of disposers) dispose();
    };
  }, []);
}
