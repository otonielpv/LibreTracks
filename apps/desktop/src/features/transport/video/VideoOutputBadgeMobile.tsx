import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { VideoOutputStatus } from "../desktopApi";
import { useDismissOnBack } from "../mobile/backNavigation";
import { useSongStore } from "../songStore";
import { runVideoLiveAction } from "./videoLive";
import { useVideoStore } from "./videoStore";

type Appearance = { tone: string; icon: string };

/** Icon and colour of the compact badge for each output state. */
export function mobileBadgeAppearance(
  state: VideoOutputStatus["state"]["state"],
  forcedBlack: boolean,
): Appearance {
  switch (state) {
    case "ready":
      return forcedBlack ? { tone: "is-black", icon: "hide_image" } : { tone: "is-ok", icon: "videocam" };
    case "standby":
      return { tone: "is-ok", icon: "videocam" };
    case "suspended":
      return { tone: "is-warning", icon: "screen_lock_portrait" };
    case "noDisplay":
      return { tone: "is-warning", icon: "tv_off" };
    case "displayLost":
    case "error":
    case "unavailable":
      return { tone: "is-error", icon: "videocam_off" };
    case "disabled":
    default:
      return { tone: "is-off", icon: "videocam_off" };
  }
}

/**
 * The video output in the phone's top bar (plan video-mobile, paso 10 §3–4):
 * ONE icon, whatever the state, so it never changes the bar's width (two
 * icons pushed the transport into a scroll on an iPhone). The icon says the
 * state, black included; tapping it opens a sheet floating over the timeline
 * with the emergency black first, then the state and the wizard.
 */
export function VideoOutputBadgeMobile() {
  const { t } = useTranslation();
  const status = useVideoStore((state) => state.outputStatus);
  const forcedBlack = useVideoStore((state) => state.forcedBlack);
  const openWizard = useVideoStore((state) => state.openWizard);
  const songHasVideo = useSongStore((state) => (state.song?.videoClips?.length ?? 0) > 0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  useDismissOnBack(closeSheet, sheetOpen);
  if (!status || !songHasVideo) return null;

  const state = status.state.state;
  const { tone, icon } = mobileBadgeAppearance(state, forcedBlack);
  const showing = state === "ready" || state === "suspended";
  const stateText = t(`transport.video.settings.state.${state}`);
  const detail = status.state.state === "error" || status.state.state === "unavailable" ? status.state.detail : null;

  return (
    <div className="lt-video-output-mobile" data-lt-native-touch>
      <button
        type="button"
        className={`lt-video-output-badge is-icon is-compact ${tone}`}
        aria-label={stateText}
        aria-expanded={sheetOpen}
        title={stateText}
        onClick={() => setSheetOpen((open) => !open)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          {icon}
        </span>
      </button>
      {sheetOpen ? (
        <div className="lt-video-output-sheet" role="dialog" aria-label={t("transport.video.badge.statusTitle")}>
          <button
            type="button"
            className={`lt-video-black-button${forcedBlack ? " is-on" : ""}`}
            aria-pressed={forcedBlack}
            disabled={!showing}
            onClick={() => void runVideoLiveAction("black")}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {forcedBlack ? "image" : "hide_image"}
            </span>
            {t(forcedBlack ? "transport.video.badge.blackOn" : "transport.video.badge.blackOff")}
          </button>
          <strong>{t("transport.video.badge.statusTitle")}</strong>
          <p>{stateText}</p>
          {status.monitorName ? <p>{status.monitorName}</p> : null}
          {detail ? <p className="is-error">{detail}</p> : null}
          {state === "suspended" ? <p>{t("transport.video.badge.suspendedHint")}</p> : null}
          {showing ? (
            <p>
              {status.dualPlayers
                ? t("transport.video.badge.players", { count: 2 })
                : (status.playersNote ?? t("transport.video.badge.players", { count: 1 }))}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setSheetOpen(false);
              openWizard();
            }}
          >
            {t("transport.video.settings.wizard")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
