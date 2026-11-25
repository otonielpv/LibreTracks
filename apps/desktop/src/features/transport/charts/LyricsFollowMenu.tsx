import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

import type { FollowFocus } from "@libretracks/shared/models";
import { DEFAULT_FOLLOW_FOCUS, FOLLOW_FOCUSES, parseFollowFocus } from "@libretracks/shared/charts/lyricsFollow";

import { PopoverShell } from "../panels/PopoverShell";

const GENERAL_KEY = "lt.liveChart.follow";

function readGeneral(): FollowFocus {
  try {
    return parseFollowFocus(window.localStorage.getItem(GENERAL_KEY)) ?? DEFAULT_FOLLOW_FOCUS;
  } catch {
    return DEFAULT_FOLLOW_FOCUS;
  }
}

/** The device's lyrics follow, shared by Live, Setlist and full screen. */
export const useGeneralFollowStore = create<{ focus: FollowFocus; set: (focus: FollowFocus) => void; reload: () => void }>((set) => ({
  focus: readGeneral(),
  set: (focus) => {
    try {
      window.localStorage.setItem(GENERAL_KEY, String(focus));
    } catch {
      // Private mode: it just does not stick.
    }
    set({ focus });
  },
  reload: () => set({ focus: readGeneral() }),
}));

type LyricsFollowMenuProps = {
  general: FollowFocus;
  /** This song's own, or `null` when it uses the general one. */
  song: FollowFocus | null;
  onGeneral: (focus: FollowFocus) => void;
  /** `null` = "like all songs". Absent when the song cannot be edited. */
  onSong: ((focus: FollowFocus | null) => void) | null;
};

/** "Follow" in the lyrics toolbar: this song's own first, then all songs (this device). */
export function LyricsFollowMenu({ general, song, onGeneral, onSong }: LyricsFollowMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const name = (focus: FollowFocus) => t(`lyricsFollow.focus.${focus}`);
  // A segmented row; `shown` is the lit segment, `inherited` dims it (the song follows all songs).
  const segments = (label: string, shown: FollowFocus, inherited: boolean, onPick: (focus: FollowFocus) => void) => (
    <div className={`lt-lyrics-follow-segments${inherited ? " is-inherited" : ""}`} role="group" aria-label={label}>
      {FOLLOW_FOCUSES.map((focus) => (
        <button
          key={String(focus)}
          type="button"
          role="menuitemradio"
          aria-checked={!inherited && focus === shown}
          aria-label={name(focus)}
          title={name(focus)}
          className={focus === shown ? "is-active" : undefined}
          onClick={() => onPick(focus)}
        >
          {t(`lyricsFollow.short.${focus}`)}
        </button>
      ))}
    </div>
  );
  return (
    <div className="lt-lyrics-follow">
      <button
        ref={anchorRef}
        type="button"
        className={`lt-icon-button${song !== null ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        aria-label={t("lyricsFollow.title")}
        title={`${t("lyricsFollow.title")}: ${name(song ?? general)}${song !== null ? ` (${t("lyricsFollow.thisSong")})` : ""}`}
      >
        <span className="material-symbols-outlined" aria-hidden="true">format_line_spacing</span>
      </button>
      <PopoverShell
        open={open}
        anchorRef={anchorRef}
        ariaLabel={t("lyricsFollow.title")}
        onClose={close}
        className="lt-pads-popover lt-lyrics-follow-panel"
        role="menu"
      >
        <header className="lt-lyrics-follow-header">
          <span className="material-symbols-outlined" aria-hidden="true">format_line_spacing</span>
          <strong>{t("lyricsFollow.title")}</strong>
        </header>
        {onSong ? (
          <section className="lt-lyrics-follow-section">
            <div className="lt-lyrics-follow-row">
              <span className="lt-lyrics-follow-label">{t("lyricsFollow.thisSong")}</span>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={song === null}
                className={`lt-lyrics-follow-switch${song === null ? " is-on" : ""}`}
                onClick={() => onSong(song === null ? general : null)}
              >
                <span className="lt-lyrics-follow-switch-track" aria-hidden="true">
                  <span className="lt-lyrics-follow-switch-thumb" />
                </span>
                {t("lyricsFollow.likeAll")}
              </button>
            </div>
            {segments(t("lyricsFollow.thisSong"), song ?? general, song === null, (focus) => onSong(focus))}
          </section>
        ) : null}
        <section className="lt-lyrics-follow-section">
          <div className="lt-lyrics-follow-row">
            <span className="lt-lyrics-follow-label">{t("lyricsFollow.allSongs")}</span>
          </div>
          {segments(t("lyricsFollow.allSongs"), general, false, onGeneral)}
        </section>
      </PopoverShell>
    </div>
  );
}
