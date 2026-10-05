import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDismissOnBack } from "../mobile/backNavigation";
import { useVideoStore } from "./videoStore";

/**
 * "This video has audio. Extract it as an audio track?" with a "remember my
 * choice" box, plus the progress of extractions running. Mounted by
 * VideoSetupLayer, on phones too (there the audio track plays the video file
 * itself; nothing is extracted).
 */
export function VideoAudioPrompt() {
  const { t } = useTranslation();
  const prompt = useVideoStore((state) => state.audioPrompt);
  const [remember, setRemember] = useState(false);
  // Android's Back answers "no". Stable, so the back stack keeps its order.
  const dismiss = useCallback(
    () => useVideoStore.getState().audioPrompt?.resolve({ extract: false, remember: false }),
    [],
  );
  useDismissOnBack(dismiss, prompt !== null);
  if (!prompt) return null;

  const answer = (extract: boolean) => {
    prompt.resolve({ extract, remember });
    setRemember(false);
  };

  return (
    <div className="lt-modal-backdrop">
      <section
        className="lt-settings-modal lt-video-audio-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-video-audio-prompt-title"
      >
        <header className="lt-settings-modal-header">
          <h2 id="lt-video-audio-prompt-title">{t("transport.video.audio.promptTitle", { count: prompt.count })}</h2>
        </header>
        <div className="lt-video-wizard-body">
          <p>{t("transport.video.audio.promptBody", { count: prompt.count })}</p>
          <label className="lt-video-settings-row">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            <span>{t("transport.video.audio.remember")}</span>
          </label>
        </div>
        <footer className="lt-video-wizard-footer">
          <span className="lt-video-wizard-spacer" />
          <button type="button" onClick={() => answer(false)}>
            {t("transport.video.audio.no")}
          </button>
          <button type="button" className="is-primary" onClick={() => answer(true)}>
            {t("transport.video.audio.extract")}
          </button>
        </footer>
      </section>
    </div>
  );
}

/** "Extracting audio… 42%" while extractions run. */
export function VideoAudioProgress() {
  const { t } = useTranslation();
  const progress = useVideoStore((state) => state.audioExtractions);
  const fractions = Object.values(progress);
  if (!fractions.length) return null;
  const percent = Math.round((fractions.reduce((sum, value) => sum + value, 0) / fractions.length) * 100);
  return (
    <div className="lt-video-setup-notice" role="status" aria-live="polite">
      <span className="material-symbols-outlined" aria-hidden="true">
        graphic_eq
      </span>
      <span>{t("transport.video.audio.progress", { count: fractions.length, percent })}</span>
    </div>
  );
}
