import {
  DEFAULT_VIDEO_OUTPUT_SETTINGS,
  getSettings,
  listVideoDisplays,
  type VideoDisplayOption,
  type VideoOutputSettings,
} from "../desktopApi";
import { useVideoStore, type VideoSetupNotice } from "./videoStore";

/**
 * When the display setup wizard (paso 10) shows up on its own. The decisions
 * are pure; the two `run*` functions read the settings and the monitors and
 * act on the video store.
 */

/** No display chosen, or the output switched off: nothing would project. */
export function outputIsUnconfigured(settings: VideoOutputSettings) {
  return !settings.enabled || settings.display == null;
}

/** "\\.\DISPLAY2" → "DISPLAY2". */
export function shortDisplayName(name: string) {
  return name.split(/[\\/]/).filter(Boolean).pop() ?? name;
}

/**
 * The notice on opening a session: none without video or when already
 * dismissed for this session; "displayMissing" when the chosen display is
 * not connected; "configure" when there is no output set up at all.
 */
export function sessionSetupNotice(input: {
  sessionKey: string;
  songHasVideo: boolean;
  settings: VideoOutputSettings;
  displays: VideoDisplayOption[];
  dismissedSessions: string[];
}): VideoSetupNotice | null {
  const { sessionKey, songHasVideo, settings, displays, dismissedSessions } = input;
  if (!songHasVideo || dismissedSessions.includes(sessionKey)) return null;
  if (outputIsUnconfigured(settings)) return { kind: "configure", sessionKey };
  const chosen = settings.display;
  if (chosen && !displays.some((display) => display.name === chosen.name)) {
    return { kind: "displayMissing", sessionKey, displayName: shortDisplayName(chosen.name) };
  }
  return null;
}

async function currentVideoSettings() {
  const appSettings = await getSettings();
  return { ...DEFAULT_VIDEO_OUTPUT_SETTINGS, ...(appSettings.videoOutput ?? {}) };
}

/** The first video clip of the session landed on the timeline. */
export async function runFirstVideoClipTrigger() {
  const store = useVideoStore.getState();
  if (!store.status?.available || store.wizardOpen) return;
  try {
    if (outputIsUnconfigured(await currentVideoSettings())) {
      useVideoStore.getState().openWizard(0);
    }
  } catch {
    // Settings unreadable: the user still has Settings → Video.
  }
}

/** A session was opened (or switched): maybe tell the user about video. */
export async function runSessionOpenTrigger(sessionKey: string, songHasVideo: boolean) {
  const store = useVideoStore.getState();
  if (!songHasVideo || !store.status?.available) {
    if (store.setupNotice && store.setupNotice.sessionKey !== sessionKey) {
      store.setSetupNotice(null);
    }
    return;
  }
  try {
    const [settings, displays] = await Promise.all([currentVideoSettings(), listVideoDisplays()]);
    const notice = sessionSetupNotice({
      sessionKey,
      songHasVideo,
      settings,
      displays,
      dismissedSessions: useVideoStore.getState().dismissedSetupSessions,
    });
    useVideoStore.getState().setSetupNotice(notice);
  } catch {
    // Monitors or settings unreadable: no notice rather than a wrong one.
  }
}
