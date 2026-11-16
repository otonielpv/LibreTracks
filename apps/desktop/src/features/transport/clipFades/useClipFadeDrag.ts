import { useEffect, useMemo, useRef } from "react";

import { createClipFadeDrag, type ClipFadeDragDeps } from "./clipFadeDrag";

type LiveDeps = Omit<ClipFadeDragDeps, "updateFades" | "target">;

/**
 * The fade-handle drag, built once. The panel's callbacks change identity on
 * every render, so they are read through a ref instead of rebuilding the
 * factory (and losing a drag in flight) each time.
 */
export function useClipFadeDrag(deps: LiveDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const drag = useMemo(
    () =>
      createClipFadeDrag({
        getCameraX: () => depsRef.current.getCameraX(),
        getPixelsPerSecond: () => depsRef.current.getPixelsPerSecond(),
        runAction: (action) => depsRef.current.runAction(action),
        applyPlaybackSnapshot: (snapshot) => depsRef.current.applyPlaybackSnapshot(snapshot),
        selectClip: (clipId, trackId) => depsRef.current.selectClip(clipId, trackId),
        getSelectedClips: () => depsRef.current.getSelectedClips(),
      }),
    [],
  );
  useEffect(() => () => drag.cancel(), [drag]);
  return drag;
}
