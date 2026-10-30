import { useState } from "react";
import { useTranslation } from "react-i18next";

import { isMobileApp } from "../desktopApi";

import { getSong } from "../songStore";
import { useTimelineUIStore } from "../uiStore";
import { describeMidiTarget } from "./controllerTargets";

/**
 * The strip that says MIDI Map mode is on (plan midi-controllers, paso 05).
 * It is the way out on a phone, where there is no keyboard for Ctrl+M or
 * Escape, and it names the control being learned.
 */
export function MidiMapBanner({
  describe,
}: {
  /** Label of a transport key (the rows the settings tab already names). */
  describe?: (key: string) => string;
}) {
  const { t } = useTranslation();
  const learnMode = useTimelineUIStore((state) => state.midiLearnMode);
  // On a phone the bottom-centre is where the setting sheets open (vamp,
  // jumps): a compact pill in a corner, and a tap on it moves it to the
  // other edge if it still covers something.
  const [atTop, setAtTop] = useState(false);
  if (learnMode === null) {
    return null;
  }
  const target =
    learnMode === ""
      ? null
      : (describeMidiTarget(learnMode, t, getSong()) ?? describe?.(learnMode) ?? learnMode);
  return (
    <div
      className={`lt-midi-map-banner${isMobileApp ? " is-compact" : ""}${atTop ? " is-top" : ""}`}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        className="lt-midi-map-banner-move"
        aria-label={t("midiMap.moveBanner")}
        onClick={() => setAtTop((value) => !value)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          graphic_eq
        </span>
        <span className="lt-midi-map-banner-text">
          {isMobileApp
            ? target
              ? t("midiMap.bannerTargetShort")
              : t("midiMap.bannerShort")
            : target
              ? t("midiMap.bannerTarget", { target })
              : t("midiMap.banner")}
        </span>
      </button>
      <button
        type="button"
        className="lt-midi-map-banner-exit"
        onClick={() => useTimelineUIStore.getState().setMidiLearnMode(null)}
      >
        {t("midiMap.exit")}
      </button>
    </div>
  );
}
