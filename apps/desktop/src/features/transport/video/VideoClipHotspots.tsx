import { useTranslation } from "react-i18next";

import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";

import type { SongView, VideoClipSummary } from "../desktopApi";
import type { VideoClipHandlers } from "./videoClipHandlers";
import { useVideoClipHotspots, type VideoDragMode } from "./useVideoClipHotspots";

/** What the video feature hands every video lane (see useVideoFeature). */
export type VideoLaneBindings = {
  handlers: VideoClipHandlers;
  readOnly: boolean;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, clip: VideoClipSummary) => void;
};

/**
 * Invisible hit targets over one video lane: the body moves the clip, the
 * edges trim it and the two top handles set its fades. The canvas paints the
 * clip; `left`/`width` are owned by the rAF loop in `useVideoClipHotspots`.
 */
export function VideoClipHotspots({
  trackId,
  song,
  rowHeight,
  camera,
  snapEnabled,
  lane,
}: {
  trackId: string;
  song: SongView | null;
  rowHeight: number;
  camera: {
    cameraXRef: MutableRefObject<number>;
    livePixelsPerSecondRef: MutableRefObject<number>;
    pixelsPerSecond: number;
  };
  snapEnabled?: boolean;
  lane: VideoLaneBindings;
}) {
  const { t } = useTranslation();
  const controller = useVideoClipHotspots({ song, ...camera, snapEnabled, ...lane });
  const clips = (song?.videoClips ?? []).filter((clip) => clip.trackId === trackId);
  const { register, beginDrag, updateDrag, endDrag, openContextMenu, readOnly } = controller;

  const handle = (mode: VideoDragMode, className: string, clip: (typeof clips)[number]) => (
    <span
      className={className}
      aria-hidden="true"
      onPointerDown={(event) => beginDrag(event, clip, mode)}
      onPointerMove={updateDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );

  return (
    <>
      {clips.map((clip) => (
        <div
          key={clip.id}
          ref={(element) => register(clip.id, element)}
          className={`lt-video-clip-hotspot${readOnly ? " is-read-only" : ""}`}
          data-video-clip-id={clip.id}
          title={readOnly ? t("transport.video.readOnly") : undefined}
          style={{ top: 2, height: Math.max(4, rowHeight - 4) }}
          onMouseDown={(event) => {
            if (event.button === 0) event.preventDefault();
            event.stopPropagation();
          }}
          onPointerDown={(event) => beginDrag(event, clip, "move")}
          onPointerMove={updateDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onContextMenu={(event) => openContextMenu(event, clip)}
        >
          {readOnly ? null : (
            <>
              {handle("trimStart", "lt-video-trim is-start", clip)}
              {handle("trimEnd", "lt-video-trim is-end", clip)}
              {handle("fadeIn", "lt-video-fade is-in", clip)}
              {handle("fadeOut", "lt-video-fade is-out", clip)}
            </>
          )}
        </div>
      ))}
    </>
  );
}
