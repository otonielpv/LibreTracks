import {
  getVideoLiveState,
  listenToVideoLiveState,
  videoLiveAction,
  type VideoLiveAction,
  type VideoLiveState,
} from "../desktopApi";
import { useVideoStore } from "./videoStore";

/**
 * Live control of the video output (paso 13): black, fade to black, idle
 * screen, output on/off. The backend owns the state (MIDI and the remote
 * press the same buttons); the UI mirrors it from `video:live-state`.
 */

export function applyVideoLiveState(state: VideoLiveState) {
  const store = useVideoStore.getState();
  store.setForcedBlack(state.forcedBlack);
  store.setForcedIdle(state.forcedIdle);
}

export async function runVideoLiveAction(action: VideoLiveAction) {
  try {
    applyVideoLiveState(await videoLiveAction(action));
  } catch {
    // Output unavailable: the badge already says why.
  }
}

/** Mirror the backend state, including presses from MIDI or the remote. */
export function subscribeToVideoLiveState(): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void getVideoLiveState()
    .then((state) => {
      if (!cancelled) applyVideoLiveState(state);
    })
    .catch(() => undefined);
  void listenToVideoLiveState(applyVideoLiveState)
    .then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** Keyboard-shortcut handlers for the video actions (`video.*` in the
 * registry), spread into the timeline dispatcher. */
export const VIDEO_SHORTCUT_HANDLERS = {
  "video.black": (event: KeyboardEvent) => {
    event.preventDefault();
    if (!event.repeat) void runVideoLiveAction("black");
  },
  "video.fadeBlack": (event: KeyboardEvent) => {
    event.preventDefault();
    if (!event.repeat) void runVideoLiveAction("fadeBlack");
  },
  "video.idle": (event: KeyboardEvent) => {
    event.preventDefault();
    if (!event.repeat) void runVideoLiveAction("idle");
  },
  "video.toggleOutput": (event: KeyboardEvent) => {
    event.preventDefault();
    if (!event.repeat) void runVideoLiveAction("output");
  },
} as const;
