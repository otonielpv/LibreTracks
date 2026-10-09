import { useTranslation } from "react-i18next";

import { fadeOutAndStop } from "../desktopApi";
import { useTransportStore } from "../store";

type FadeStopButtonProps = {
  /** MIDI-learn mode: a click picks this action as the learn target instead. */
  learnModeActive?: boolean;
  onMidiLearnTarget?: (controlKey: string) => void;
  className?: string;
};

/**
 * «Fade out y parar»: cut the playing song with a fade instead of a hard stop.
 * Lit while the fade runs; pressing it again then stops at once. The backend
 * owns the timing (it reads the duration from settings), so this only fires
 * the command — the next transport poll brings the new state in.
 *
 * Self-contained on purpose: it reads the store and calls the API itself, so
 * the topbar and the live view can drop it in without new props through the
 * transport panel.
 */
export function FadeStopButton({
  learnModeActive = false,
  onMidiLearnTarget,
  className = "",
}: FadeStopButtonProps) {
  const { t } = useTranslation();
  const isPlaying = useTransportStore(
    (state) => state.playback?.playbackState === "playing",
  );
  const fading = useTransportStore(
    (state) => state.playback?.fadingToStop === true,
  );

  const label = fading ? t("timelineTopbar.fadeOutStopActive") : t("timelineTopbar.fadeOutStop");

  return (
    <button
      type="button"
      className={`${className}${fading ? " is-active" : ""}`.trim()}
      aria-label={label}
      title={label}
      aria-pressed={fading}
      disabled={!isPlaying && !fading && !learnModeActive}
      onClick={() => {
        if (learnModeActive) {
          onMidiLearnTarget?.("action:fade_out_stop");
          return;
        }
        void fadeOutAndStop().catch(() => undefined);
      }}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        trending_down
      </span>
    </button>
  );
}
