import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import {
  DEFAULT_VIDEO_OUTPUT_SETTINGS,
  applyVideoOutputSettings,
  getSettings,
  getVideoMediaStatus,
  getVideoSyncStats,
  identifyVideoDisplays,
  listVideoDisplays,
  setVideoCalibration,
  showVideoTestPattern,
  type VideoDisplayOption,
  type VideoOutputSettings,
  type VideoSyncStats,
} from "../desktopApi";
import { useSongStore } from "../songStore";
import { estimateFromTaps, MAX_OFFSET_MS, MIN_OFFSET_MS, type TapCalibration } from "../video/videoCalibration";
import { useVideoStore } from "../video/videoStore";

const TAPS_NEEDED = 10;

/** "\\.\DISPLAY2" → "DISPLAY2". */
function displayName(name: string) {
  return name.split(/[\\/]/).filter(Boolean).pop() ?? name;
}

/**
 * Settings → Video (desktop only). Every control applies at once: the fit
 * does not reopen the output window, the display and the mode do. Without
 * libmpv the tab explains why and everything is disabled.
 */
export function VideoSettingsTab() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<VideoOutputSettings>(DEFAULT_VIDEO_OUTPUT_SETTINGS);
  const [displays, setDisplays] = useState<VideoDisplayOption[]>([]);
  const [stats, setStats] = useState<VideoSyncStats | null>(null);
  const [testPattern, setTestPattern] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [flashTaps, setFlashTaps] = useState<number[]>([]);
  const [clickTaps, setClickTaps] = useState<number[]>([]);
  const [tapResult, setTapResult] = useState<TapCalibration | null>(null);
  const mediaStatus = useVideoStore((state) => state.status);
  const outputStatus = useVideoStore((state) => state.outputStatus);
  const openWizard = useVideoStore((state) => state.openWizard);
  const song = useSongStore((state) => state.song);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const refreshDisplays = useCallback(() => {
    void listVideoDisplays()
      .then(setDisplays)
      .catch(() => setDisplays([]));
  }, []);

  useEffect(() => {
    void getSettings()
      .then((appSettings) =>
        setSettings({ ...DEFAULT_VIDEO_OUTPUT_SETTINGS, ...(appSettings.videoOutput ?? {}) }),
      )
      .catch(() => undefined);
    void getVideoMediaStatus()
      .then((status) => useVideoStore.getState().setMediaStatus(status))
      .catch(() => undefined);
    refreshDisplays();
    const timer = window.setInterval(() => {
      void getVideoSyncStats().then(setStats).catch(() => undefined);
    }, 1000);
    return () => {
      window.clearInterval(timer);
      // Leaving the tab ends a calibration or test pattern in progress.
      void setVideoCalibration(null).catch(() => undefined);
      void showVideoTestPattern(false).catch(() => undefined);
    };
  }, [refreshDisplays]);

  const available = mediaStatus?.available ?? false;
  const disabled = !available;

  const apply = (patch: Partial<VideoOutputSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    setSettings(next);
    void applyVideoOutputSettings(next).catch(() => undefined);
  };

  const selectedDisplay = displays.find(
    (display) => settings.display && display.name === settings.display.name,
  );

  const pickIdleImage = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: t("transport.video.settings.imageFilter"), extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof picked === "string") {
      apply({ idle: { kind: "image", path: picked } });
    }
  };

  const beatGrid = () => {
    const bpm = song?.bpm && song.bpm > 0 ? song.bpm : 120;
    return { interval: 60 / bpm, firstBeat: song?.regions?.[0]?.startSeconds ?? 0 };
  };

  const toggleCalibration = () => {
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
          currentOffsetMs: settingsRef.current.latencyOffsetMs,
        }),
      );
    }
  };

  const outputState = outputStatus?.state.state ?? "disabled";

  return (
    <section
      className="lt-settings-tab-panel lt-video-settings"
      role="tabpanel"
      id="lt-settings-panel-video"
      aria-labelledby="lt-settings-tab-video"
    >
      <div className="lt-video-settings-status" role="status">
        {available ? (
          <span>
            {t("transport.video.settings.libmpvOk", { version: mediaStatus?.clientApiVersion ?? "?" })}
            {" · "}
            {t(`transport.video.settings.state.${outputState}`)}
          </span>
        ) : (
          <span className="is-error">
            {t("transport.video.settings.unavailable", { reason: mediaStatus?.reason ?? "?" })}
          </span>
        )}
      </div>

      <label className="lt-settings-field lt-video-settings-row">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(event) => apply({ enabled: event.target.checked })}
        />
        <span>{t("transport.video.settings.enabled")}</span>
      </label>

      <div className="lt-settings-field">
        <span>{t("transport.video.settings.display")}</span>
        <div className="lt-video-settings-row">
          <select
            aria-label={t("transport.video.settings.display")}
            disabled={disabled}
            value={selectedDisplay?.name ?? ""}
            onChange={(event) => {
              const display = displays.find((item) => item.name === event.target.value);
              apply({
                display: display
                  ? { name: display.name, width: display.width, height: display.height, x: display.x, y: display.y }
                  : null,
              });
            }}
          >
            <option value="">{t("transport.video.settings.noDisplay")}</option>
            {displays.map((display) => (
              <option key={display.name} value={display.name}>
                {`${display.number} · ${displayName(display.name)} · ${display.width}×${display.height}`}
                {display.isPrimary ? ` (${t("transport.video.settings.primary")})` : ""}
                {display.hasApp ? ` (${t("transport.video.settings.hasApp")})` : ""}
              </option>
            ))}
          </select>
          <button type="button" disabled={disabled} onClick={refreshDisplays}>
            {t("transport.video.settings.refresh")}
          </button>
          <button type="button" disabled={disabled} onClick={() => void identifyVideoDisplays()}>
            {t("transport.video.settings.identify")}
          </button>
        </div>
        {outputStatus?.sharesAppDisplay ? (
          <small className="is-warning">{t("transport.video.badge.sharesApp")}</small>
        ) : null}
      </div>

      <label className="lt-settings-field">
        <span>{t("transport.video.settings.mode")}</span>
        <select
          disabled={disabled}
          value={settings.mode}
          onChange={(event) => apply({ mode: event.target.value as VideoOutputSettings["mode"] })}
        >
          <option value="fullscreen">{t("transport.video.settings.modeFullscreen")}</option>
          <option value="window">{t("transport.video.settings.modeWindow")}</option>
        </select>
      </label>

      <label className="lt-settings-field">
        <span>{t("transport.video.settings.fit")}</span>
        <select
          disabled={disabled}
          value={settings.fit}
          onChange={(event) => apply({ fit: event.target.value as VideoOutputSettings["fit"] })}
        >
          <option value="contain">{t("transport.video.menu.fitContain")}</option>
          <option value="cover">{t("transport.video.menu.fitCover")}</option>
          <option value="stretch">{t("transport.video.menu.fitStretch")}</option>
        </select>
      </label>

      <div className="lt-settings-field">
        <span>{t("transport.video.settings.idle")}</span>
        <div className="lt-video-settings-row">
          <select
            aria-label={t("transport.video.settings.idle")}
            disabled={disabled}
            value={settings.idle.kind}
            onChange={(event) =>
              event.target.value === "black" ? apply({ idle: { kind: "black" } }) : void pickIdleImage()
            }
          >
            <option value="black">{t("transport.video.settings.idleBlack")}</option>
            <option value="image">{t("transport.video.settings.idleImage")}</option>
          </select>
          {settings.idle.kind === "image" ? (
            <>
              <small className="lt-video-settings-path" title={settings.idle.path}>
                {displayName(settings.idle.path)}
              </small>
              <button type="button" disabled={disabled} onClick={() => void pickIdleImage()}>
                {t("transport.video.settings.chooseImage")}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <label className="lt-settings-field">
        <span>{t("transport.video.settings.whenStopped")}</span>
        <select
          disabled={disabled}
          value={settings.whenStopped}
          onChange={(event) =>
            apply({ whenStopped: event.target.value as VideoOutputSettings["whenStopped"] })
          }
        >
          <option value="lastFrame">{t("transport.video.settings.stoppedLastFrame")}</option>
          <option value="idle">{t("transport.video.settings.stoppedIdle")}</option>
          <option value="black">{t("transport.video.settings.stoppedBlack")}</option>
        </select>
      </label>

      <label className="lt-settings-field">
        <span>{t("transport.video.settings.hwdec")}</span>
        <select
          disabled={disabled}
          value={settings.hwdec}
          onChange={(event) => apply({ hwdec: event.target.value as VideoOutputSettings["hwdec"] })}
        >
          <option value="auto">{t("transport.video.settings.hwdecAuto")}</option>
          <option value="off">{t("transport.video.settings.hwdecOff")}</option>
        </select>
      </label>

      <div className="lt-settings-field">
        <span>{t("transport.video.settings.latency")}</span>
        <div className="lt-video-settings-row">
          <input
            type="range"
            aria-label={t("transport.video.settings.latency")}
            min={MIN_OFFSET_MS}
            max={MAX_OFFSET_MS}
            step={5}
            disabled={disabled}
            value={settings.latencyOffsetMs}
            onChange={(event) => apply({ latencyOffsetMs: Number(event.target.value) })}
          />
          <input
            type="number"
            aria-label={t("transport.video.settings.latencyMs")}
            min={MIN_OFFSET_MS}
            max={MAX_OFFSET_MS}
            disabled={disabled}
            value={settings.latencyOffsetMs}
            onChange={(event) =>
              apply({
                latencyOffsetMs: Math.max(MIN_OFFSET_MS, Math.min(MAX_OFFSET_MS, Number(event.target.value) || 0)),
              })
            }
          />
          <span>ms</span>
          <button type="button" disabled={disabled || !settings.enabled} onClick={toggleCalibration}>
            {calibrating ? t("transport.video.settings.calibrationStop") : t("transport.video.settings.calibrate")}
          </button>
        </div>
        <small>{t("transport.video.settings.latencyHint")}</small>
      </div>

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
              <button type="button" onClick={() => apply({ latencyOffsetMs: tapResult.suggestedOffsetMs })}>
                {t("transport.video.settings.tapApply")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="lt-video-settings-row">
        <button
          type="button"
          disabled={disabled || !settings.enabled}
          aria-pressed={testPattern}
          onClick={() => {
            const next = !testPattern;
            setTestPattern(next);
            void showVideoTestPattern(next).catch(() => undefined);
          }}
        >
          {t("transport.video.settings.testPattern")}
        </button>
        <button type="button" disabled={disabled} onClick={() => openWizard()}>
          {t("transport.video.settings.wizard")}
        </button>
      </div>

      <dl className="lt-video-settings-stats">
        <dt>{t("transport.video.settings.statsError")}</dt>
        <dd>
          {stats?.errorP95Ms != null
            ? `${stats.errorP50Ms?.toFixed(1)} / ${stats.errorP95Ms.toFixed(1)} ms`
            : "—"}
        </dd>
        <dt>{t("transport.video.settings.statsHwdec")}</dt>
        <dd>{stats?.hwdec ?? "—"}</dd>
        <dt>{t("transport.video.settings.statsCorrections")}</dt>
        <dd>
          {stats ? `${stats.forcedSeeks} / ${stats.swaps} / ${stats.frameDrops}` : "—"}
        </dd>
      </dl>
    </section>
  );
}
