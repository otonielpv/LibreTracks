import { useTranslation } from "react-i18next";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import { SetlistEditButton } from "./SetlistEditDrawer";
import { useSetlistStore } from "./setlistStore";
import type { SetlistLayoutClass } from "./useSetlistLayout";

/** The view buttons (Mix/Song on the phone, Lyrics, Edit). The Setlist puts
 * them in the song row, the waveform's dock or the console's rail. */
export function SetlistPaneButtons({
  layout,
  lyricsActive,
  lyricsPane,
}: {
  layout: SetlistLayoutClass;
  /** Lyrics are showing, beside the song or as the phone's pane. */
  lyricsActive: boolean;
  lyricsPane: boolean;
}) {
  const { t } = useTranslation();
  const shortPane = useSetlistStore((state) => state.shortPane);
  const setShortPane = useSetlistStore((state) => state.setShortPane);
  const lyricsOpenSetting = useSetlistStore((state) => state.lyricsOpen);
  const setLyricsOpen = useSetlistStore((state) => state.setLyricsOpen);
  return (
    <>
      {layout === "short" ? (
        <button
          type="button"
          // A way to the other view, not a state: it is never lit (lit, «Mix»
          // read as if the mixer were what you were looking at).
          className="lt-setlist-pane-toggle"
          title={t(shortPane === "song" ? "setlistView.pane.showMixerTitle" : "setlistView.pane.showSongTitle")}
          onClick={() => setShortPane(shortPane === "song" ? "mixer" : "song")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {shortPane === "song" ? "tune" : "graphic_eq"}
          </span>
          {t(shortPane === "song" ? "setlistView.pane.mixer" : "setlistView.pane.song")}
        </button>
      ) : null}
      {FEATURE_FLAGS.lyrics ? (
        <button
          type="button"
          className={`lt-setlist-pane-toggle${lyricsActive ? " is-active" : ""}`}
          aria-pressed={lyricsActive}
          title={t("setlistView.lyrics.toggleTitle")}
          onClick={() => {
            if (layout === "short") setShortPane(lyricsPane ? "mixer" : "lyrics");
            else setLyricsOpen(!lyricsOpenSetting);
          }}
        >
          <span className="material-symbols-outlined" aria-hidden="true">lyrics</span>
          {t("setlistView.lyrics.button")}
        </button>
      ) : null}
      <SetlistEditButton />
    </>
  );
}
