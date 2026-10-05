import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";

import { alertDialog } from "../../../shared/dialog/dialogService";
import { skippedImportsMessage } from "../library/importPipeline";

import {
  getVideoMediaStatus,
  isMobileApp,
  isTauriApp,
  listenToVideoAudioExtractProgress,
  listenToVideoDeviceImportDone,
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
import { runFirstVideoClipTrigger, runSessionOpenTrigger } from "./videoSetupTriggers";
import { subscribeToVideoLiveState } from "./videoLive";

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
  /** First video clip of the session. Defaults to the setup wizard's
   * trigger (paso 10); tests override it. */
  onFirstVideoClip?: () => void;
};

export function useVideoFeature(deps: VideoFeatureDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  // Plan video-mobile, paso 09: video plays on phones too. What decides
  // whether it can be edited is the backend's capability (the native players
  // started), not the platform. On the desktop editing never depended on
  // libmpv, and still does not.
  const backendAvailable = useVideoStore((state) => state.status?.available ?? false);
  const editable = !isMobileApp || backendAvailable;

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
        onFirstVideoClip: () =>
          (depsRef.current.onFirstVideoClip ?? (() => void runFirstVideoClipTrigger()))(),
        canExtractAudio: !isMobileApp,
      }),
    [],
  );

  // Videos added from the phone arrive when the backend has copied them
  // (plan video-mobile, paso 08 §3).
  useEffect(() => {
    if (!isTauriApp) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listenToVideoDeviceImportDone((done) => handlers.finishDeviceImport(done))
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handlers]);

  // Whether the backend can play video (libmpv on the desktop, the native
  // players on a phone). On a phone it is only known once the output thread
  // reported, so it is asked again when the output status changes.
  const outputState = useVideoStore((state) => state.outputStatus?.state.state ?? null);
  useEffect(() => {
    if (!isTauriApp) return;
    void getVideoMediaStatus()
      .then((status) => useVideoStore.getState().setMediaStatus(status))
      .catch(() => undefined);
  }, [outputState]);

  // The video library follows the open session.
  const sessionKey = `${deps.song?.id ?? ""}|${deps.song?.sessionName ?? ""}`;
  useEffect(() => {
    if (!deps.song) return;
    void listVideoAssets()
      .then((assets) => useVideoStore.getState().setAssets(assets))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // Opening a session with video on a machine without the output set up (or
  // with its display unplugged) shows a non-blocking notice.
  // Once per session, as soon as libmpv's status is known: a first clip
  // added later is the wizard's business, not the notice's.
  const libmpvAvailable = useVideoStore((state) => state.status?.available ?? false);
  const noticeCheckedForRef = useRef<string | null>(null);
  useEffect(() => {
    // The desktop's notice and wizard; a phone's setup is paso 10's.
    if (isMobileApp || !deps.song || !libmpvAvailable) return;
    if (noticeCheckedForRef.current === sessionKey) return;
    noticeCheckedForRef.current = sessionKey;
    void runSessionOpenTrigger(sessionKey, (deps.song.videoClips?.length ?? 0) > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, libmpvAvailable]);

  useVideoThumbnails(deps.song, true);

  // Black / idle pressed from anywhere (shortcut, MIDI, remote): the badge
  // follows the backend (paso 13).
  useEffect(() => subscribeToVideoLiveState(), []);

  // Progress of audio extractions (paso 11), shown by VideoAudioProgress.
  useEffect(() => {
    if (isMobileApp) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listenToVideoAudioExtractProgress(({ clipId, fraction }) => {
      if (clipId in useVideoStore.getState().audioExtractions) {
        useVideoStore.getState().setAudioExtraction(clipId, fraction);
      }
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // The library's "put it on the timeline" action: at the playhead, on the
  // selected video track if there is one, else on a new video track. A phone
  // also offers "add a video from the device" there (paso 08 §3).
  useEffect(() => {
    if (!editable) return;
    const atPlayhead = () => ({
      seconds: depsRef.current.getPlayheadSeconds(),
      trackId: useTimelineUIStore.getState().selectedTrackIds[0] ?? null,
    });
    const store = useVideoStore.getState();
    store.setPlaceAtPlayhead((asset) => handlers.placeLibraryAssets([asset], atPlayhead()));
    store.setAddFromDevice(isMobileApp ? () => handlers.addVideosFromDevice(atPlayhead()) : null);
    return () => {
      useVideoStore.getState().setPlaceAtPlayhead(null);
      useVideoStore.getState().setAddFromDevice(null);
    };
  }, [editable, handlers]);

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
      readOnly: !editable,
      onContextMenu: (event, clip) => depsRef.current.openClipMenu(event, clip),
    }),
    [handlers, editable],
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
    /** For libraryDragDrop's `importVideoPaths`: files dropped from the OS,
     * referenced in place. A phone has no such drop; it copies picked videos
     * into the session instead (`handlers.addVideosFromDevice`). */
    importVideoPaths: !isMobileApp ? handlers.importVideoPaths : undefined,
    /** For timelineMenus' `videoHandlers` (absent where video is read-only). */
    handlers: editable ? handlers : undefined,
    /** For TimelineCanvasPane's `videoLanes`. */
    lanes,
    /** For useTimelineKeyboardShortcuts' `videoEdits`. */
    keyboardEdits: editable ? keyboardEdits : undefined,
  };
}
