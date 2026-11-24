import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

import type { FollowFocus } from "@libretracks/shared/models";
import { DEFAULT_FOLLOW_FOCUS, FOLLOW_FOCUSES, parseFollowFocus } from "@libretracks/shared/charts/lyricsFollow";

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

/** "Follow" in the lyrics toolbar: for all songs (this device) and only for this song. */
export function LyricsFollowMenu({ general, song, onGeneral, onSong }: LyricsFollowMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const name = (focus: FollowFocus) => t(`lyricsFollow.focus.${focus}`);
  const option = (focus: FollowFocus | null, active: boolean, onPick: () => void, label: string) => (
    <button
      key={String(focus)}
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={active ? "is-active" : undefined}
      onClick={() => {
        onPick();
        setOpen(false);
      }}
    >
      <span className="material-symbols-outlined" aria-hidden="true">{active ? "radio_button_checked" : "radio_button_unchecked"}</span>
      {label}
    </button>
  );
  return (
    <div className="lt-lyrics-follow" ref={rootRef}>
      <button
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
      {open ? (
        <div className="lt-context-menu lt-lyrics-follow-menu" role="menu" aria-label={t("lyricsFollow.title")}>
          <strong>{t("lyricsFollow.allSongs")}</strong>
          {FOLLOW_FOCUSES.map((focus) => option(focus, focus === general, () => onGeneral(focus), name(focus)))}
          {onSong ? (
            <>
              <strong>{t("lyricsFollow.thisSong")}</strong>
              {option(null, song === null, () => onSong(null), t("lyricsFollow.likeAll"))}
              {FOLLOW_FOCUSES.map((focus) => option(focus, focus === song, () => onSong(focus), name(focus)))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
