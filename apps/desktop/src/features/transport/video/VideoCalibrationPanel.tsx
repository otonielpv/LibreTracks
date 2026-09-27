import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { setVideoCalibration } from "../desktopApi";
import { useSongStore } from "../songStore";
import { estimateFromTaps, type TapCalibration } from "./videoCalibration";

const TAPS_NEEDED = 10;

type VideoCalibrationPanelProps = {
  /** The output is on: the flash has somewhere to show. */
  canCalibrate: boolean;
  latencyOffsetMs: number;
  onApplyOffset: (offsetMs: number) => void;
};

/**
 * Latency calibration (paso 09), shared by Settings → Video and the setup
 * wizard. While it runs the output flashes white on every beat of the song
 * grid; the user either moves the offset until flash and click line up, or
 * taps along to both and takes the suggested offset. Unmounting ends it.
 */
export function VideoCalibrationPanel({
  canCalibrate,
  latencyOffsetMs,
  onApplyOffset,
}: VideoCalibrationPanelProps) {
  const { t } = useTranslation();
  const song = useSongStore((state) => state.song);
  const [calibrating, setCalibrating] = useState(false);
  const [flashTaps, setFlashTaps] = useState<number[]>([]);
  const [clickTaps, setClickTaps] = useState<number[]>([]);
  const [tapResult, setTapResult] = useState<TapCalibration | null>(null);

  useEffect(
    () => () => {
      void setVideoCalibration(null).catch(() => undefined);
    },
    [],
  );

  const beatGrid = () => {
    const bpm = song?.bpm && song.bpm > 0 ? song.bpm : 120;
    return { interval: 60 / bpm, firstBeat: song?.regions?.[0]?.startSeconds ?? 0 };
  };

  const toggle = () => {
    const next = !calibrating;
    setCalibrating(next);
    setFlashTaps([]);
    setClickTaps([]);
    setTapResult(null);
    void setVideoCalibration(next ? beatGrid() : null).catch(() => undefined);
  };

  const recordTap = (kind: "flash" | "click") => {
    const now = performance.now() / 1000;
    const flash = kind === "flash" ? [...flashTaps, now].slice(-TAPS_NEEDED) : flashTaps;
    const click = kind === "click" ? [...clickTaps, now].slice(-TAPS_NEEDED) : clickTaps;
    setFlashTaps(flash);
    setClickTaps(click);
    if (flash.length >= TAPS_NEEDED && click.length >= TAPS_NEEDED) {
      setTapResult(
        estimateFromTaps({
          flashTaps: flash,
          clickTaps: click,
          interval: beatGrid().interval,
          // Taps are in wall time: centre the grid on the first click tap.
          phase: click[0],
          currentOffsetMs: latencyOffsetMs,
        }),
      );
    }
  };

  return (
    <div className="lt-video-calibration-panel">
      <button type="button" disabled={!canCalibrate} onClick={toggle}>
        {calibrating ? t("transport.video.settings.calibrationStop") : t("transport.video.settings.calibrate")}
      </button>
      {calibrating ? (
        <div className="lt-video-calibration" role="group" aria-label={t("transport.video.settings.calibrate")}>
          <p>{t("transport.video.settings.calibrationSteps")}</p>
          <p>{t("transport.video.settings.tapHint")}</p>
          <div className="lt-video-settings-row">
            <button type="button" onPointerDown={() => recordTap("flash")}>
              {t("transport.video.settings.tapFlash", { count: flashTaps.length, total: TAPS_NEEDED })}
            </button>
            <button type="button" onPointerDown={() => recordTap("click")}>
              {t("transport.video.settings.tapClick", { count: clickTaps.length, total: TAPS_NEEDED })}
            </button>
          </div>
          {tapResult ? (
            <div className="lt-video-settings-row">
              <span>
                {t("transport.video.settings.tapResult", {
                  lag: tapResult.pictureLagMs,
                  offset: tapResult.suggestedOffsetMs,
                })}
              </span>
              <button type="button" onClick={() => onApplyOffset(tapResult.suggestedOffsetMs)}>
                {t("transport.video.settings.tapApply")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
