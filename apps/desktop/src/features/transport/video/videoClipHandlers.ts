import {
  createTrack,
  deleteVideoClips,
  duplicateVideoClips,
  importVideoFiles,
  moveVideoClip,
  placeVideoClips,
  splitVideoClips,
  trimVideoClip,
  updateVideoClip,
  type SkippedImport,
  type SongView,
  type TransportSnapshot,
  type VideoAssetSummary,
  type VideoClipProps,
  type VideoClipSummary,
  type VideoFit,
} from "../desktopApi";
import { useVideoStore } from "./videoStore";

/**
 * Handlers for video: importing files, placing them on the timeline and every
 * clip edit (move, trim, fades, fit, colour, split, duplicate, delete).
 *
 * Built once with `useMemo` by `useVideoFeature`, following the repo's rule
 * that a feature brings its own module and the transport monolith only calls
 * into it. Volatile state (the song, the playhead) is read through getters so
 * the factory never has to be recreated.
 */
export type VideoClipHandlerDeps = {
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  translate: (key: string, options?: Record<string, unknown>) => string;
  getSong: () => SongView | null;
  /** Reload the video library list after an import. */
  refreshVideoAssets: () => Promise<void>;
  /** Report files an import left out, like the audio importer does. */
  reportSkipped: (skipped: SkippedImport[]) => void;
  /** Called after the session's first video clip is created (paso 10 opens
   * the display wizard from here when no output is configured). */
  onFirstVideoClip: () => void;
};

export type VideoPlacement = { seconds: number; trackId: string | null };

function findClip(song: SongView | null, clipId: string): VideoClipSummary | null {
  return song?.videoClips?.find((clip) => clip.id === clipId) ?? null;
}

function propsOf(clip: VideoClipSummary): VideoClipProps {
  return {
    fadeInSeconds: clip.fadeInSeconds ?? null,
    fadeOutSeconds: clip.fadeOutSeconds ?? null,
    fit: clip.fit ?? null,
    color: clip.color ?? null,
  };
}

export function createVideoClipHandlers(deps: VideoClipHandlerDeps) {
  const {
    runAction,
    applyPlaybackSnapshot,
    setStatus,
    translate: t,
    getSong,
    refreshVideoAssets,
    reportSkipped,
    onFirstVideoClip,
  } = deps;

  const songHasVideo = () => (getSong()?.videoClips?.length ?? 0) > 0;

  /** Place already-imported assets back to back from `placement`. */
  const placeAssets = async (assets: VideoAssetSummary[], placement: VideoPlacement) => {
    if (!assets.length) return;
    const hadVideo = songHasVideo();
    const snapshot = await placeVideoClips(
      assets.map((asset) => ({
        filePath: asset.filePath,
        durationSeconds: asset.info.durationSeconds,
      })),
      placement.seconds,
      placement.trackId,
    );
    applyPlaybackSnapshot(snapshot);
    setStatus(t("transport.video.placed", { count: assets.length }));
    if (!hadVideo) {
      onFirstVideoClip();
    }
  };

  /** Analyse and register dropped/picked videos; with a placement, also put
   * them on the timeline. The analysis runs in the backend off the session
   * lock, so the UI stays live while it works. */
  const importVideoPaths = (paths: string[], placement: VideoPlacement | null) => {
    if (!paths.length) return;
    setStatus(t("transport.video.analyzing", { count: paths.length }));
    void runAction(async () => {
      const result = await importVideoFiles(paths);
      reportSkipped(result.skipped);
      await refreshVideoAssets();
      if (!result.assets.length) return;
      if (placement) {
        await placeAssets(result.assets, placement);
      } else {
        setStatus(t("transport.video.imported", { count: result.assets.length }));
      }
    });
  };

  const placeLibraryAssets = (assets: VideoAssetSummary[], placement: VideoPlacement) => {
    void runAction(async () => {
      await placeAssets(assets, placement);
    });
  };

  const moveClip = (clipId: string, startSeconds: number, targetTrackId: string | null) => {
    void runAction(async () => {
      applyPlaybackSnapshot(await moveVideoClip(clipId, startSeconds, targetTrackId));
      setStatus(t("transport.video.clipMoved"));
    });
  };

  const trimClip = (clipId: string, startSeconds: number, endSeconds: number) => {
    void runAction(async () => {
      applyPlaybackSnapshot(await trimVideoClip(clipId, startSeconds, endSeconds));
      setStatus(t("transport.video.clipTrimmed"));
    });
  };

  /** Change some of a clip's properties, keeping the rest. */
  const patchClip = (clipId: string, patch: Partial<VideoClipProps>) => {
    const clip = findClip(getSong(), clipId);
    if (!clip) return;
    void runAction(async () => {
      applyPlaybackSnapshot(await updateVideoClip(clipId, { ...propsOf(clip), ...patch }));
      setStatus(t("transport.video.clipUpdated"));
    });
  };

  const setFades = (clipId: string, fadeInSeconds: number, fadeOutSeconds: number) =>
    patchClip(clipId, {
      fadeInSeconds: fadeInSeconds > 0 ? fadeInSeconds : null,
      fadeOutSeconds: fadeOutSeconds > 0 ? fadeOutSeconds : null,
    });
  const setFit = (clipId: string, fit: VideoFit | null) => patchClip(clipId, { fit });
  const setColor = (clipId: string, color: string | null) => patchClip(clipId, { color });

  const selectedIds = () => useVideoStore.getState().selectedVideoClipIds;

  /** Split the selected video clips at `seconds`. False when none is selected
   * (so the audio split still runs for audio selections). */
  const splitSelectedAt = async (seconds: number): Promise<boolean> => {
    const ids = selectedIds();
    if (!ids.length) return false;
    await runAction(async () => {
      applyPlaybackSnapshot(await splitVideoClips(ids, seconds));
      useVideoStore.getState().clearVideoSelection();
      setStatus(t("transport.video.clipSplit"));
    });
    return true;
  };

  const deleteClips = (ids: string[]) => {
    if (!ids.length) return;
    void runAction(async () => {
      applyPlaybackSnapshot(await deleteVideoClips(ids));
      useVideoStore.getState().clearVideoSelection();
      setStatus(t("transport.video.clipsDeleted", { count: ids.length }));
    });
  };

  const duplicateClips = (ids: string[]) => {
    if (!ids.length) return;
    void runAction(async () => {
      applyPlaybackSnapshot(await duplicateVideoClips(ids));
      setStatus(t("transport.video.clipsDuplicated"));
    });
  };

  /** Keyboard entry points: true when a video selection handled the key. */
  const deleteSelected = () => {
    const ids = selectedIds();
    deleteClips([...ids]);
    return ids.length > 0;
  };
  const duplicateSelected = () => {
    const ids = selectedIds();
    duplicateClips([...ids]);
    return ids.length > 0;
  };

  const addVideoTrack = (insertAfterTrackId: string | null = null) => {
    void runAction(async () => {
      applyPlaybackSnapshot(
        await createTrack({
          name: t("transport.video.trackDefaultName"),
          kind: "video",
          insertAfterTrackId,
        }),
      );
      setStatus(t("transport.video.trackAdded"));
    });
  };

  return {
    importVideoPaths,
    placeLibraryAssets,
    moveClip,
    trimClip,
    setFades,
    setFit,
    setColor,
    splitSelectedAt,
    deleteClips,
    duplicateClips,
    deleteSelected,
    duplicateSelected,
    addVideoTrack,
  };
}

export type VideoClipHandlers = ReturnType<typeof createVideoClipHandlers>;
