import { useEffect, useMemo } from "react";

import type {
  MixSceneMode,
  MixSceneSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  deleteMixScene,
  reorderMixScenes,
  triggerMixScene,
  upsertMixScene,
} from "../../desktopApi";
import { useMixSceneTriggerStore } from "../../scenes/SceneButtons";

export type MixSceneHandlerDeps = {
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSongView: (options?: { sync?: boolean; includeWaveforms?: boolean }) => Promise<unknown>;
};

/**
 * Mix scene commands (plan live-scenes). Editing a scene refreshes the song
 * view so cues and buttons see it; triggering one is live state and only
 * publishes the snapshot, whose `mixRevision` makes the mixer refetch.
 */
export function createMixSceneHandlers({
  runAction,
  applyPlaybackSnapshot,
  refreshSongView,
}: MixSceneHandlerDeps) {
  const edit = (call: () => Promise<TransportSnapshot>) =>
    runAction(async () => {
      applyPlaybackSnapshot(await call());
      await refreshSongView({ includeWaveforms: false, sync: true });
    });

  return {
    upsert: (scene: MixSceneSummary) => edit(() => upsertMixScene(scene)),
    remove: (sceneId: string) => edit(() => deleteMixScene(sceneId)),
    reorder: (sceneIds: string[]) => edit(() => reorderMixScenes(sceneIds)),
    trigger: (sceneId: string, mode: MixSceneMode = "toggle") =>
      runAction(async () => {
        applyPlaybackSnapshot(await triggerMixScene(sceneId, mode));
      }),
  };
}

export type MixSceneHandlers = ReturnType<typeof createMixSceneHandlers>;

/**
 * The handlers, built once, with `trigger` registered for the scene buttons
 * the views host (`scenes/SceneButtons.tsx`).
 */
export function useMixSceneHandlers(deps: MixSceneHandlerDeps) {
  const { runAction, applyPlaybackSnapshot, refreshSongView } = deps;
  const handlers = useMemo(
    () => createMixSceneHandlers({ runAction, applyPlaybackSnapshot, refreshSongView }),
    [runAction, applyPlaybackSnapshot, refreshSongView],
  );
  useEffect(() => {
    useMixSceneTriggerStore.setState({ trigger: handlers.trigger });
    return () => useMixSceneTriggerStore.setState({ trigger: null });
  }, [handlers]);
  return handlers;
}
