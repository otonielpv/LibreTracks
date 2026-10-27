import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useSetlistStore } from "./setlistStore";

/**
 * Phone, waveform pane: the view buttons (Mix, Lyrics, Edit) over the bottom
 * right of the waveform, as Playback has them, with an arrow that folds them
 * against the right edge so the whole waveform shows. Folded or not is
 * remembered for the session (setlistStore).
 */
export function WaveDock({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const hidden = useSetlistStore((state) => state.waveDockHidden);
  const setHidden = useSetlistStore((state) => state.setWaveDockHidden);
  const label = t(hidden ? "setlistView.dock.show" : "setlistView.dock.hide");
  return (
    <div className={`lt-setlist-wave-dock${hidden ? " is-hidden" : ""}`}>
      <button
        type="button"
        className="lt-setlist-wave-dock-toggle"
        aria-expanded={!hidden}
        aria-label={label}
        title={label}
        onClick={() => setHidden(!hidden)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          {hidden ? "chevron_left" : "chevron_right"}
        </span>
      </button>
      {hidden ? null : <div className="lt-setlist-wave-dock-buttons">{children}</div>}
    </div>
  );
}
