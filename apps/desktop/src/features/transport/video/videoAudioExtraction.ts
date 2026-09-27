import { getSettings, saveSettings, type VideoAudioOnImport } from "../desktopApi";
import { useVideoStore } from "./videoStore";

/**
 * The audio of a video as its own track (paso 11): the question asked after
 * placing a video with sound, and the remembered answer.
 *
 * The question is a small dialog of the video feature (VideoAudioPrompt,
 * mounted by VideoSetupLayer) because the shared dialogs have no "remember my
 * choice" box. It is asked once per placement, however many videos it brought.
 */
export type VideoAudioChoice = { extract: boolean; remember: boolean };

/** Show the question and wait for the answer. */
export function askVideoAudioExtraction(count: number): Promise<VideoAudioChoice> {
  return new Promise((resolve) => {
    const store = useVideoStore.getState();
    // A question still open is answered "no" rather than left hanging.
    store.audioPrompt?.resolve({ extract: false, remember: false });
    store.setAudioPrompt({
      count,
      resolve: (choice) => {
        useVideoStore.getState().setAudioPrompt(null);
        resolve(choice);
      },
    });
  });
}

/**
 * Whether to extract the audio of `count` just-placed videos with sound:
 * the remembered choice, or the user's answer (remembered if they asked).
 */
export async function decideVideoAudioExtraction(
  count: number,
  ask: (count: number) => Promise<VideoAudioChoice> = askVideoAudioExtraction,
): Promise<boolean> {
  if (count <= 0) return false;
  let settings;
  try {
    settings = await getSettings();
  } catch {
    settings = null;
  }
  const mode: VideoAudioOnImport = settings?.videoAudioOnImport ?? "ask";
  if (mode !== "ask") return mode === "extract";

  const choice = await ask(count);
  if (choice.remember && settings) {
    try {
      await saveSettings({ ...settings, videoAudioOnImport: choice.extract ? "extract" : "skip" });
    } catch {
      // Not remembered this time; the answer still applies.
    }
  }
  return choice.extract;
}
