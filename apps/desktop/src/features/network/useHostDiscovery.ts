import { useEffect, useState } from "react";

import {
  listenToDiscoveredHosts,
  startDiscovery,
  stopDiscovery,
  type NetworkDiscoveredHost,
} from "@libretracks/shared/networkApi";
import { isTauriApp } from "@libretracks/shared/desktopApi";

/** How long without finding anything before the screen explains why. */
export const NOT_FOUND_HINT_MS = 8000;

/**
 * Looks for hosts on the LAN while `active` (the Join tab is open and this
 * device has not joined). Stops when it is not: browsing keeps a multicast
 * lock on Android, which costs battery.
 */
export function useHostDiscovery(active: boolean) {
  const [hosts, setHosts] = useState<NetworkDiscoveredHost[]>([]);
  const [showHints, setShowHints] = useState(false);

  useEffect(() => {
    if (!active || !isTauriApp) {
      setHosts([]);
      setShowHints(false);
      return () => {};
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenToDiscoveredHosts((next) => {
      if (!disposed) setHosts(next);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {});
    void startDiscovery()
      .then((known) => {
        if (!disposed) setHosts((current) => (current.length ? current : known));
      })
      .catch(() => {});
    const timer = window.setTimeout(() => {
      if (!disposed) setShowHints(true);
    }, NOT_FOUND_HINT_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten?.();
      void stopDiscovery().catch(() => {});
    };
  }, [active]);

  return { hosts, showNotFoundHints: showHints && hosts.length === 0 };
}
