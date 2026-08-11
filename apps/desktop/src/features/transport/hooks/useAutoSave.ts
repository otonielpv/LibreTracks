import { useEffect, useRef } from "react";

import { saveProject, type TransportSnapshot } from "../desktopApi";
import { useTransportStore } from "../store";

/**
 * Decide what an autosave tick should do. Pure so the policy is testable
 * without timers, a session or the Tauri bridge.
 *
 * Autosave is deliberately conservative — it must never surprise the user or
 * fight the transport:
 *
 * - Nothing changed since the last save (`revision === lastSavedRevision`):
 *   skip. An idle session never touches the disk.
 * - No session on disk yet (`songFilePath` empty): skip. A never-saved project
 *   has no path, and autosave must not raise a "Save as..." dialog behind the
 *   user's back — that is an explicit action.
 * - Playing: skip. `save_project` runs synchronously under the session lock, so
 *   writing mid-performance risks an audible hiccup. The tick is dropped and
 *   the next one (or the stop) picks the work up; the revision check means the
 *   pending change is still saved as soon as the transport is idle.
 * - A save is already running: skip, so a slow write can't queue up saves.
 */
export function shouldAutoSave({
  enabled,
  revision,
  lastSavedRevision,
  songFilePath,
  isPlaying,
  isSaving,
}: {
  enabled: boolean;
  revision: number;
  lastSavedRevision: number;
  songFilePath: string | null | undefined;
  isPlaying: boolean;
  isSaving: boolean;
}): boolean {
  if (!enabled || isSaving || isPlaying) {
    return false;
  }
  if (!songFilePath) {
    return false;
  }
  return revision !== lastSavedRevision;
}

export type UseAutoSaveOptions = {
  enabled: boolean;
  intervalMinutes: number;
  /** Publishes the snapshot returned by the save into the transport store. */
  applyPlaybackSnapshot: (snapshot: TransportSnapshot) => void;
  setStatus: (message: string) => void;
  formatErrorStatus: (error: unknown) => string;
  t: (key: string, options?: Record<string, unknown>) => string;
};

/**
 * Periodically saves the loaded session so an unexpected crash or power cut
 * loses at most one interval of work.
 *
 * The timer is the only thing this hook owns. Whether a given tick actually
 * saves is decided by `shouldAutoSave` above.
 */
export function useAutoSave({
  enabled,
  intervalMinutes,
  applyPlaybackSnapshot,
  setStatus,
  formatErrorStatus,
  t,
}: UseAutoSaveOptions) {
  // Revision last written to disk. Seeded to -1 (never a real revision) so a
  // session opened with pending changes still autosaves on the first tick.
  const lastSavedRevisionRef = useRef(-1);
  const isSavingRef = useRef(false);
  // Read at tick time so changing these identities does not re-arm the
  // interval (which would reset the countdown on every render).
  const depsRef = useRef({
    applyPlaybackSnapshot,
    setStatus,
    formatErrorStatus,
    t,
  });
  depsRef.current = { applyPlaybackSnapshot, setStatus, formatErrorStatus, t };

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const periodMs = Math.max(1, intervalMinutes) * 60_000;
    const timerId = window.setInterval(() => {
      const playback = useTransportStore.getState().playback;
      const revision = playback?.projectRevision ?? 0;

      if (
        !shouldAutoSave({
          enabled: true,
          revision,
          lastSavedRevision: lastSavedRevisionRef.current,
          songFilePath: playback?.songFilePath,
          isPlaying: playback?.playbackState === "playing",
          isSaving: isSavingRef.current,
        })
      ) {
        return;
      }

      // Note this does NOT go through runAction({ busy: true }): that raises
      // the blocking shell overlay. An autosave must be invisible, so it calls
      // saveProject() directly and only reports on the status line.
      isSavingRef.current = true;
      void saveProject()
        .then((snapshot) => {
          lastSavedRevisionRef.current = revision;
          depsRef.current.applyPlaybackSnapshot(snapshot);
          depsRef.current.setStatus(
            depsRef.current.t("transport.status.projectAutoSaved", {
              defaultValue: "Proyecto guardado automáticamente.",
            }),
          );
        })
        .catch((error: unknown) => {
          // lastSavedRevision stays put so the next tick retries.
          depsRef.current.setStatus(depsRef.current.formatErrorStatus(error));
        })
        .finally(() => {
          isSavingRef.current = false;
        });
    }, periodMs);

    return () => {
      window.clearInterval(timerId);
    };
  }, [enabled, intervalMinutes]);
}
