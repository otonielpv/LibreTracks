import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import {
  getVideoOutputStatus,
  isMobileApp,
  isTauriApp,
  listenToVideoOutputStatus,
} from "../desktopApi";
import { useSongStore } from "../songStore";
import { runVideoLiveAction } from "./videoLive";
import { useVideoStore } from "./videoStore";

/** Keeps `videoStore.outputStatus` in step with the backend's
 * `video:output-status` event. Mounted once, by the badge. */
function useVideoOutputStatusSync() {
  useEffect(() => {
    if (!isTauriApp || isMobileApp) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const store = useVideoStore.getState();
    void getVideoOutputStatus()
      .then((status) => {
        if (!disposed) store.setOutputStatus(status);
      })
      .catch(() => undefined);
    void listenToVideoOutputStatus((status) => store.setOutputStatus(status))
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/**
 * Video output button in the transport bar, next to the audio badge. Self
 * contained: no props, no re-renders of the transport tree. Only there when
 * the session has video. Clicking it shows or hides the output window (the
 * way back after closing it). When all is well it is just an icon; it spells
 * out only what the technician must see at once: the picture blacked out, or
 * what is wrong (display unplugged, libmpv missing).
 */
export function VideoOutputBadge() {
  const { t } = useTranslation();
  useVideoOutputStatusSync();
  const status = useVideoStore((state) => state.outputStatus);
  const forcedBlack = useVideoStore((state) => state.forcedBlack);
  const openWizard = useVideoStore((state) => state.openWizard);
  const songHasVideo = useSongStore((state) => (state.song?.videoClips?.length ?? 0) > 0);
  if (!status || !songHasVideo) return null;

  // "\\.\DISPLAY2" → "DISPLAY2": the Windows device prefix means nothing to a user.
  const monitor = (status.monitorName ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  let tone = "is-ok";
  let icon = "videocam";
  let label: string | null = null;
  let title: string;
  let onClick: (() => void) | undefined = () => void runVideoLiveAction("output");
  switch (status.state.state) {
    case "disabled":
      tone = "is-off";
      icon = "videocam_off";
      title = t("transport.video.badge.off");
      break;
    case "ready":
    case "standby":
      if (forcedBlack) {
        tone = "is-black";
        icon = "hide_image";
        label = t("transport.video.badge.black");
      } else if (status.sharesAppDisplay) {
        tone = "is-warning";
      }
      title = [
        t("transport.video.badge.ready", { monitor }),
        status.sharesAppDisplay ? t("transport.video.badge.sharesApp") : null,
        t("transport.video.badge.hide"),
      ]
        .filter(Boolean)
        .join("\n");
      break;
    case "displayLost":
      label = t("transport.video.badge.displayLost");
      title = label;
      tone = "is-error";
      break;
    case "noDisplay":
      label = t("transport.video.badge.noDisplay");
      title = label;
      tone = "is-warning";
      onClick = () => openWizard();
      break;
    case "unavailable":
      label = t("transport.video.badge.unavailable");
      title = status.state.detail;
      tone = "is-error";
      onClick = undefined;
      break;
    case "error":
      label = t("transport.video.badge.error");
      title = status.state.detail;
      tone = "is-error";
      break;
  }
  return (
    <button
      type="button"
      className={`lt-video-output-badge ${tone}${label ? "" : " is-icon"}`}
      title={title}
      aria-label={label ?? title}
      disabled={!onClick}
      onClick={onClick}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        {icon}
      </span>
      {label}
    </button>
  );
}
