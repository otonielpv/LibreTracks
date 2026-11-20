import { useEffect } from "react";

import { isTauriApp } from "@libretracks/shared/desktopApi";

import {
  getLyricsConfig,
  getLyricsStatus,
  listenToLyricsLinks,
  listenToLyricsStatus,
} from "../lyricsApi";
import { useLyricsStore } from "../lyricsStore";

/** Follows `lyrics:status` and `lyrics:link` into the store. Mounted once,
 * by `LyricsRoot`. `onLinkChanged`: a song's link was stored behind the
 * user's back (found by name); the song view has to be read again. */
export function useLyricsStatus(onLinkChanged?: () => void) {
  useEffect(() => {
    if (!isTauriApp) return () => {};
    const store = useLyricsStore.getState();
    let disposed = false;
    const disposers: Array<() => void> = [];
    const keep = (unlisten: () => void) => {
      if (disposed) unlisten();
      else disposers.push(unlisten);
    };
    void listenToLyricsStatus(store.setStatus).then(keep).catch(() => {});
    void listenToLyricsLinks(() => {
      useLyricsStore.getState().bumpLinks();
      onLinkChanged?.();
    })
      .then(keep)
      .catch(() => {});
    void getLyricsStatus()
      .then((status) => {
        if (!disposed) store.setStatus(status);
      })
      .catch(() => {});
    void getLyricsConfig()
      .then((view) => {
        if (!disposed) store.setConfigView(view);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      disposers.forEach((dispose) => dispose());
    };
    // onLinkChanged is read once: the root passes a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
