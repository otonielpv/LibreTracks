import type { TrackSummary } from "@libretracks/shared/models";

import { isMobileApp, pickLibraryFiles } from "../desktopApi";
import { classifyDroppedPaths } from "../library/dragDrop";
import { useTimelineUIStore } from "../uiStore";
import type { VideoLaneBindings } from "../video/VideoClipHotspots";

/**
 * «+ Video» at `seconds`: the DAW's import (with its «extract the audio?»
 * question) on `trackId`, else the selected video track, else the song's
 * first one, else a new one. A phone picks from its gallery or its files.
 * Shared by Edit → Lanes and Edit → Video.
 */
export function addVideoAt(
  video: VideoLaneBindings,
  tracks: readonly TrackSummary[],
  seconds: number,
  options: { trackId?: string | null; source?: "gallery" | "files" } = {},
) {
  const videoTrackIds = tracks.filter((track) => track.kind === "video").map((track) => track.id);
  const selected = useTimelineUIStore.getState().selectedTrackIds.find((id) => videoTrackIds.includes(id));
  const placement = { seconds, trackId: options.trackId ?? selected ?? videoTrackIds[0] ?? null };
  if (isMobileApp) {
    video.handlers.addVideosFromDevice(placement, options.source ?? "gallery");
    return;
  }
  void pickLibraryFiles().then((paths) => {
    const classification = classifyDroppedPaths(paths);
    const videos = ("videoPaths" in classification ? classification.videoPaths : undefined) ?? [];
    if (videos.length) video.handlers.importVideoPaths(videos, placement);
  });
}
