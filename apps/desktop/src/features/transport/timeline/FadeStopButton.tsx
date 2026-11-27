import { useTranslation } from "react-i18next";

import { fadeOutAndStop } from "../desktopApi";
import { useTransportStore } from "../store";
import { MidiMappable } from "../midi/MidiMappable";

type FadeStopButtonProps = {
  /** MIDI-learn mode: a click picks this action as the learn target instead. */
  learnModeActive?: boolean;
  onMidiLearnTarget?: (controlKey: string) => void;
  /** No song loaded: nothing to fade in. */
  isProjectEmpty?: boolean;
  className?: string;
};

/**
 * Fade out the playing song and pause or stop according to the setting.
 * Lit while the fade runs; pressing it again then stops at once.
 *
 * Stopped or paused it is «Fade in y reproducir»: plays from the cursor with
 * the tracks rising over the same time (going back to a chorus without it all
 * coming in at once). The backend owns the timing and picks the direction from
 * its own state, so this only fires the command; the next transport poll
 * brings the new state in.
 *
 * Self-contained on purpose: it reads the store and calls the API itself, so
 * the topbar and the live view can drop it in without new props through the
 * transport panel.
 */
export function FadeStopButton({
  learnModeActive = false,
  onMidiLearnTarget,
  isProjectEmpty = false,
  className = "",
}: FadeStopButtonProps) {
  const { t } = useTranslation();
  const isPlaying = useTransportStore(
    (state) => state.playback?.playbackState === "playing",
  );
  const fading = useTransportStore(
    (state) => state.playback?.fadingToStop === true,
  );

  const fadesIn = !isPlaying && !fading;
  const label = fading
    ? t("timelineTopbar.fadeOutStopActive")
    : fadesIn
      ? t("timelineTopbar.fadeInPlay")
      : t("timelineTopbar.fadeOutStop");

  return (
    <MidiMappable target="action:fade_out_stop">
    <button
      type="button"
      className={`${className}${fading ? " is-active" : ""}`.trim()}
      aria-label={label}
      title={label}
      aria-pressed={fading}
      disabled={fadesIn && isProjectEmpty && !learnModeActive}
      onClick={() => {
        if (learnModeActive) {
          onMidiLearnTarget?.("action:fade_out_stop");
          return;
        }
        void fadeOutAndStop().catch(() => undefined);
      }}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        {fadesIn ? "trending_up" : "trending_down"}
      </span>
    </button>
    </MidiMappable>
  );
}
