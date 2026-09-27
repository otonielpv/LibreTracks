import type { SongView } from "../desktopApi";
import {
  droppedFilePaths,
  isVideoFilePath,
  type NativeDroppedPathClassification,
} from "./dragDrop";

/**
 * Where dropped or picked video files go: to the video feature, never to the
 * audio importer (a video dropped on an audio track must not become an audio
 * clip). Kept out of libraryDragDrop.ts, which is under a size budget.
 */
export type VideoDropPlacement = { seconds: number; trackId: string | null };

export type VideoPathSink = {
  /** Absent where video is not supported (mobile). */
  importVideoPaths?: (paths: string[], placement: VideoDropPlacement | null) => void;
  setStatus: (message: string) => void;
  t: (key: string) => string;
};

function send(sink: VideoPathSink, paths: string[], placement: VideoDropPlacement | null) {
  if (!paths.length) return;
  if (!sink.importVideoPaths) {
    sink.setStatus(sink.t("transport.video.desktopOnly"));
    return;
  }
  sink.importVideoPaths(paths, placement);
}

/** Hand the videos among `paths` to the video feature and return the rest. */
export function divertVideoPaths(
  sink: VideoPathSink,
  paths: string[],
  placement: VideoDropPlacement | null,
): string[] {
  send(sink, paths.filter(isVideoFilePath), placement);
  return paths.filter((path) => !isVideoFilePath(path));
}

/** Route the videos of a timeline drop. True when the drop had only videos,
 * i.e. there is nothing left for the audio importer. */
export function routeDroppedVideos(
  sink: VideoPathSink,
  classification: NativeDroppedPathClassification,
  placement: VideoDropPlacement,
): boolean {
  if (classification.kind === "video") {
    send(sink, classification.videoPaths, placement);
    return true;
  }
  if (classification.kind === "audio") {
    send(sink, classification.videoPaths ?? [], placement);
  }
  return false;
}

/**
 * The videos of a DOM drop on the timeline (the one the timeline acts on).
 * Videos go by path, never read as bytes (they can be gigabytes). WebView2
 * usually gives DOM files no path: then this returns false and the caller
 * leaves the whole drop to the native drop event, which has the paths.
 */
export function routeDomDroppedVideos(
  sink: VideoPathSink,
  videoFiles: File[],
  seconds: number,
): boolean {
  if (!videoFiles.length) return true;
  const paths = droppedFilePaths(videoFiles);
  if (!paths) return false;
  send(sink, paths, { seconds, trackId: null });
  return true;
}

/** Videos dropped on a song column of the compact view land at the start of
 * that song. True when the drop was handled. */
export function routeCompactDroppedVideos(
  sink: VideoPathSink,
  classification: NativeDroppedPathClassification,
  song: SongView | null,
  regionId: string | null | undefined,
): boolean {
  if (classification.kind !== "video" || !regionId) return false;
  const region = song?.regions.find((candidate) => candidate.id === regionId);
  send(sink, classification.videoPaths, { seconds: region?.startSeconds ?? 0, trackId: null });
  return true;
}
