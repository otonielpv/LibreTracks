import { isVideoFilePath, type NativeDroppedPathClassification } from "./dragDrop";

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
