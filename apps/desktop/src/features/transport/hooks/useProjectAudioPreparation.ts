import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectLoadProgressEvent } from "@libretracks/shared/models";
import { listenToProjectLoadProgress } from "../desktopApi";
import {
  SOURCES_PREPARE_INITIAL,
  type SourcesPrepareUiState,
} from "../sourcesPrepare";
import { projectAudioPreparationStateFromEvent } from "../projectAudioPreparation";

/**
 * Owns the long-lived half of a deferred project open/import.
 *
 * `project:load-complete` deliberately arrives when the model is interactive,
 * before cold audio has finished decoding. The normal loading flow therefore
 * cannot own this state: it unmounts its listener as soon as that model-ready
 * event resolves. This hook stays subscribed for the lifetime of the transport
 * and only dismisses readiness at the backend's terminal 100% event, which is
 * emitted after source decode, first-play cache preparation and Bungee prearm.
 */
export function useProjectAudioPreparation() {
  const [uiState, setUiState] = useState<SourcesPrepareUiState>(
    SOURCES_PREPARE_INITIAL,
  );
  const armedRef = useRef(false);
  const startedAtRef = useRef(0);

  const begin = useCallback((startedAtUnixMs: number) => {
    armedRef.current = true;
    startedAtRef.current = startedAtUnixMs;
    setUiState({
      active: true,
      percent: 0,
      readyCount: 0,
      total: 0,
      failedCount: 0,
    });
  }, []);

  const cancel = useCallback(() => {
    armedRef.current = false;
    setUiState(SOURCES_PREPARE_INITIAL);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listenToProjectLoadProgress((event: ProjectLoadProgressEvent) => {
      if (!armedRef.current) return;
      if (
        event.emittedAtUnixMs &&
        event.emittedAtUnixMs < startedAtRef.current
      ) {
        return;
      }

      const complete = event.percent >= 100;
      setUiState(projectAudioPreparationStateFromEvent(event));
      if (complete) {
        armedRef.current = false;
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { uiState, begin, cancel };
}
