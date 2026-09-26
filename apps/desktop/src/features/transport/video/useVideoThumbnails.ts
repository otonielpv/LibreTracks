import { useEffect, useRef } from "react";

import {
  getVideoThumbnails,
  listenToVideoThumbnailsReady,
  type SongView,
} from "../desktopApi";
import {
  forgetThumbnailStrip,
  hasThumbnailStrip,
  storeThumbnailStrip,
  videoPathKey,
} from "./videoCanvasState";

/**
 * Keeps the thumbnail strips of the song's videos loaded for the canvas.
 *
 * Asking for a strip the backend has not made yet queues it (as urgent) and
 * returns null; `video:thumbnails-ready` then says it is on disk and it is
 * fetched again. Nothing here touches React state: strips go to the canvas
 * registry, which requests its own repaint.
 */
export function useVideoThumbnails(song: SongView | null, enabled: boolean) {
  const requestedRef = useRef(new Set<string>());

  const filePaths = enabled
    ? [...new Set((song?.videoClips ?? []).filter((clip) => !clip.isMissing).map((clip) => clip.filePath))]
    : [];
  const pathsKey = filePaths.join("\u0000");

  useEffect(() => {
    if (!enabled) return;
    for (const filePath of filePaths) {
      const key = videoPathKey(filePath);
      if (hasThumbnailStrip(filePath) || requestedRef.current.has(key)) continue;
      requestedRef.current.add(key);
      void getVideoThumbnails(filePath)
        .then((strip) => {
          if (strip) storeThumbnailStrip(strip);
          else requestedRef.current.delete(key);
        })
        .catch(() => requestedRef.current.delete(key));
    }
    // `pathsKey` stands for `filePaths`: same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pathsKey]);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listenToVideoThumbnailsReady(({ filePath }) => {
      forgetThumbnailStrip(filePath);
      void getVideoThumbnails(filePath)
        .then((strip) => {
          if (strip) storeThumbnailStrip(strip);
        })
        .catch(() => undefined);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);
}
