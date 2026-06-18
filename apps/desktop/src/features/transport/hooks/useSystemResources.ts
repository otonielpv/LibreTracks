import { useEffect, useState } from "react";

import { isTauriApp, type SystemResourceSnapshot } from "@libretracks/shared/desktopApi";

import { getSystemResourceSnapshot } from "../desktopApi";

/** How often the resource meter polls the backend. ~1 Hz matches Ableton's
 * meter and is plenty for a diagnostics surface; the underlying sysinfo
 * sampling needs a gap between samples to compute CPU% anyway. */
const POLL_INTERVAL_MS = 1000;

/**
 * Polls the backend for current OS resource usage (CPU / RAM / disk) at ~1 Hz.
 *
 * Returns `null` until the first sample arrives, or permanently when not
 * running inside the Tauri shell (the web remote has no backend to ask).
 * Polling pauses while the document is hidden so a backgrounded window doesn't
 * keep waking the sampler.
 */
export function useSystemResources(): SystemResourceSnapshot | null {
  const [snapshot, setSnapshot] = useState<SystemResourceSnapshot | null>(null);

  useEffect(() => {
    if (!isTauriApp) return;

    let cancelled = false;
    // Guard against overlapping calls if a sample ever takes longer than the
    // interval (e.g. backend briefly busy) — we never queue two in flight.
    let inFlight = false;
    let timer: number | undefined;

    const poll = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const next = await getSystemResourceSnapshot();
        if (!cancelled) setSnapshot(next);
      } catch {
        // Diagnostics surface: a failed sample must never break the UI. Keep
        // the last value and try again on the next tick.
      } finally {
        inFlight = false;
      }
    };

    void poll();
    timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, []);

  return snapshot;
}
