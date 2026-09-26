import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";

import { alertDialog } from "../../../shared/dialog/dialogService";
import { skippedImportsMessage } from "../library/importPipeline";

import {
  getVideoMediaStatus,
  isMobileApp,
  listVideoAssets,
  type SkippedImport,
  type SongView,
  type TransportSnapshot,
  type VideoClipSummary,
} from "../desktopApi";
import { useTimelineUIStore } from "../uiStore";
import { createVideoClipHandlers } from "./videoClipHandlers";
import { requestVideoRepaint } from "./videoCanvasState";
import { useVideoStore } from "./videoStore";
import type { VideoLaneBindings } from "./VideoClipHotspots";
import { useVideoThumbnails } from "./useVideoThumbnails";

/**
 * The whole video feature as the transport panel sees it: one call, a few
 * values to pass on. Per the repo rule, TransportPanelContent only invokes
 * this; the state, effects and handlers live here and in `video/`.
 */
export type VideoFeatureDeps = {
  song: SongView | null;
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  getPlayheadSeconds: () => number;
  /** Opens the clip context menu (timelineMenus.openVideoClipMenu). Read at
   * event time, so it may be defined after this hook runs. */
  openClipMenu: (event: ReactMouseEvent<HTMLElement>, clip: VideoClipSummary) => void;
  /** Hook for paso 10: first video clip of the session. */
  onFirstVideoClip?: () => void;
};

export function useVideoFeature(deps: VideoFeatureDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const desktop = !isMobileApp;

  const handlers = useMemo(
    () =>
      createVideoClipHandlers({
        runAction: (action) => depsRef.current.runAction(action),
        applyPlaybackSnapshot: (snapshot) => depsRef.current.applyPlaybackSnapshot(snapshot),
        setStatus: (message) => depsRef.current.setStatus(message),
        translate: (key, options) => depsRef.current.t(key, options),
        getSong: () => depsRef.current.song,
        refreshVideoAssets: async () => {
          try {
            useVideoStore.getState().setAssets(await listVideoAssets());
          } catch {
            // No session yet, or not in the desktop app: nothing to list.
          }
        },
        reportSkipped: (skipped: SkippedImport[]) => {
          if (!skipped.length) return;
          const message = skippedImportsMessage(skipped, depsRef.current.t);
          depsRef.current.setStatus(message);
          void alertDialog(message);
        },
        onFirstVideoClip: () => depsRef.current.onFirstVideoClip?.(),
      }),
    [],
  );

  // Whether libmpv loaded, once per app run (the backend caches it too).
  useEffect(() => {
    if (!desktop) return;
    void getVideoMediaStatus()
      .then((status) => useVideoStore.getState().setMediaStatus(status))
      .catch(() => undefined);
  }, [desktop]);

  // The video library follows the open session.
  const sessionKey = `${deps.song?.id ?? ""}|${deps.song?.sessionName ?? ""}`;
  useEffect(() => {
    if (!desktop || !deps.song) return;
    void listVideoAssets()
      .then((assets) => useVideoStore.getState().setAssets(assets))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, sessionKey]);

  useVideoThumbnails(deps.song, desktop);

  // The library's "put it on the timeline" action: at the playhead, on the
  // selected video track if there is one, else on a new video track.
  useEffect(() => {
    if (!desktop) return;
    useVideoStore.getState().setPlaceAtPlayhead((asset) => {
      const selectedTrackId = useTimelineUIStore.getState().selectedTrackIds[0] ?? null;
      handlers.placeLibraryAssets([asset], {
        seconds: depsRef.current.getPlayheadSeconds(),
        trackId: selectedTrackId,
      });
    });
    return () => useVideoStore.getState().setPlaceAtPlayhead(null);
  }, [desktop, handlers]);

  // One selection at a time across audio and video unless the user extends
  // it with a modifier (the hotspots handle that side); selecting audio clips
  // with a plain click clears the video selection. Any change repaints.
  useEffect(() => {
    const unsubscribeAudio = useTimelineUIStore.subscribe((state, previous) => {
      if (
        state.selectedClipIds !== previous.selectedClipIds &&
        state.selectedClipIds.length > 0 &&
        previous.selectedClipIds.length === 0
      ) {
        useVideoStore.getState().clearVideoSelection();
      }
    });
    const unsubscribeVideo = useVideoStore.subscribe((state, previous) => {
      if (state.selectedVideoClipIds !== previous.selectedVideoClipIds) {
        requestVideoRepaint();
      }
    });
    return () => {
      unsubscribeAudio();
      unsubscribeVideo();
    };
  }, []);

  const lanes = useMemo<VideoLaneBindings>(
    () => ({
      handlers,
      readOnly: !desktop,
      onContextMenu: (event, clip) => depsRef.current.openClipMenu(event, clip),
    }),
    [handlers, desktop],
  );

  const keyboardEdits = useMemo(
    () => ({
      splitSelected: () => handlers.splitSelectedAt(depsRef.current.getPlayheadSeconds()),
      deleteSelected: handlers.deleteSelected,
      duplicateSelected: handlers.duplicateSelected,
    }),
    [handlers],
  );

  return {
    /** For libraryDragDrop's `importVideoPaths` (absent on mobile). */
    importVideoPaths: desktop ? handlers.importVideoPaths : undefined,
    /** For timelineMenus' `videoHandlers` (absent on mobile). */
    handlers: desktop ? handlers : undefined,
    /** For TimelineCanvasPane's `videoLanes`. */
    lanes,
    /** For useTimelineKeyboardShortcuts' `videoEdits`. */
    keyboardEdits: desktop ? keyboardEdits : undefined,
  };
}
