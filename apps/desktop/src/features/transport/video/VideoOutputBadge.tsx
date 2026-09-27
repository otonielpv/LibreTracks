import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import {
  getVideoOutputStatus,
  isMobileApp,
  isTauriApp,
  listenToVideoOutputStatus,
} from "../desktopApi";
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
 * Video output health in the transport bar, next to the audio badge. Self
 * contained: no props, no re-renders of the transport tree. Shows nothing
 * while the output is off; otherwise which display it is on, or what is wrong
 * (display unplugged, libmpv missing), so the technician never has to guess
 * whether the projector failed.
 */
export function VideoOutputBadge() {
  const { t } = useTranslation();
  useVideoOutputStatusSync();
  const status = useVideoStore((state) => state.outputStatus);
  const forcedBlack = useVideoStore((state) => state.forcedBlack);
  if (!status || status.state.state === "disabled") return null;

  // "\\.\DISPLAY2" → "DISPLAY2": the Windows device prefix means nothing to a user.
  const monitor = (status.monitorName ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  let tone = "is-ok";
  let label: string;
  let title: string | undefined;
  switch (status.state.state) {
    case "ready":
      label = forcedBlack
        ? t("transport.video.badge.black")
        : t("transport.video.badge.ready", { monitor });
      tone = forcedBlack ? "is-black" : status.sharesAppDisplay ? "is-warning" : "is-ok";
      title = status.sharesAppDisplay ? t("transport.video.badge.sharesApp") : undefined;
      break;
    case "displayLost":
      label = t("transport.video.badge.displayLost");
      tone = "is-error";
      break;
    case "noDisplay":
      label = t("transport.video.badge.noDisplay");
      tone = "is-warning";
      break;
    case "unavailable":
      label = t("transport.video.badge.unavailable");
      title = status.state.detail;
      tone = "is-error";
      break;
    case "error":
      label = t("transport.video.badge.error");
      title = status.state.detail;
      tone = "is-error";
      break;
  }
  return (
    <span className={`lt-video-output-badge ${tone}`} title={title} role="status">
      <span className="material-symbols-outlined" aria-hidden="true">
        {forcedBlack ? "hide_image" : "videocam"}
      </span>
      {label}
    </span>
  );
}
