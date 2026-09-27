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
  showVideoTestPattern,
  type VideoDisplayOption,
  type VideoOutputSettings,
  type VideoSyncStats,
} from "../desktopApi";
import { VideoCalibrationPanel } from "../video/VideoCalibrationPanel";
import { MAX_OFFSET_MS, MIN_OFFSET_MS } from "../video/videoCalibration";
import { useVideoStore } from "../video/videoStore";

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
  const mediaStatus = useVideoStore((state) => state.status);
  const outputStatus = useVideoStore((state) => state.outputStatus);
  const openWizard = useVideoStore((state) => state.openWizard);
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
      // Leaving the tab ends the test pattern (the calibration panel ends
      // its own calibration).
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
        </div>
        <small>{t("transport.video.settings.latencyHint")}</small>
        <VideoCalibrationPanel
          canCalibrate={!disabled && settings.enabled}
          latencyOffsetMs={settings.latencyOffsetMs}
          onApplyOffset={(offsetMs) => apply({ latencyOffsetMs: offsetMs })}
        />
      </div>

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
