import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import {
  DEFAULT_VIDEO_OUTPUT_SETTINGS,
  applyVideoOutputSettings,
  getSettings,
  identifyVideoDisplays,
  listVideoDisplays,
  showVideoTestPattern,
  type VideoDisplayOption,
  type VideoFit,
  type VideoOutputSettings,
} from "../desktopApi";
import { VideoCalibrationPanel } from "./VideoCalibrationPanel";
import { shortDisplayName } from "./videoSetupTriggers";
import { useVideoStore } from "./videoStore";

export const WIZARD_STEPS = ["welcome", "display", "check", "fit", "sync", "done"] as const;
export const WIZARD_STEP_DISPLAY = 1;

/** How often the monitor list is re-read while the wizard is open: plugging
 * the projector in makes it appear without closing anything. */
export const DISPLAY_POLL_MS = 2000;

const FITS: VideoFit[] = ["contain", "cover", "stretch"];

/**
 * The picture inside a `frameWidth` × monitor-aspect frame for each fit, in
 * px: the three thumbnails of the fit step use the real video and monitor
 * proportions.
 */
export function fitPreviewRect(fit: VideoFit, monitorAspect: number, videoAspect: number, frameWidth: number) {
  const frameHeight = frameWidth / monitorAspect;
  if (fit === "stretch") return { width: frameWidth, height: frameHeight };
  const wider = videoAspect > monitorAspect;
  const fillWidth = fit === "contain" ? wider : !wider;
  return fillWidth
    ? { width: frameWidth, height: frameWidth / videoAspect }
    : { width: frameHeight * videoAspect, height: frameHeight };
}

/** Mounted by the transport panel; renders nothing until the store opens it. */
export function VideoSetupWizard() {
  const wizardOpen = useVideoStore((state) => state.wizardOpen);
  return wizardOpen ? <VideoSetupWizardDialog /> : null;
}

/**
 * Display setup, step by step. The choices live in a draft that is applied
 * on "Done". Showing the test pattern and calibrating need the output on the
 * chosen display, so from the check step on the draft is previewed; cancelling
 * puts back the settings the wizard found.
 */
function VideoSetupWizardDialog() {
  const { t } = useTranslation();
  const mediaStatus = useVideoStore((state) => state.status);
  const assets = useVideoStore((state) => state.assets);
  const closeWizard = useVideoStore((state) => state.closeWizard);
  const [step, setStep] = useState(() => useVideoStore.getState().wizardStep);
  const [draft, setDraft] = useState<VideoOutputSettings>(DEFAULT_VIDEO_OUTPUT_SETTINGS);
  const [displays, setDisplays] = useState<VideoDisplayOption[]>([]);
  const originalRef = useRef<VideoOutputSettings | null>(null);
  const previewedRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const available = mediaStatus?.available ?? false;
  const stepName = WIZARD_STEPS[step];

  useEffect(() => {
    // A notice for this session is answered by opening the wizard.
    useVideoStore.getState().setSetupNotice(null);
    void getSettings()
      .then((appSettings) => {
        const current = { ...DEFAULT_VIDEO_OUTPUT_SETTINGS, ...(appSettings.videoOutput ?? {}) };
        originalRef.current = current;
        setDraft((previous) => (previewedRef.current ? previous : current));
      })
      .catch(() => undefined);
    const refresh = () =>
      void listVideoDisplays()
        .then(setDisplays)
        .catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, DISPLAY_POLL_MS);
    return () => {
      window.clearInterval(timer);
      void showVideoTestPattern(false).catch(() => undefined);
    };
  }, []);

  // Numbers on every screen match the cards.
  useEffect(() => {
    if (stepName === "display" && available) {
      void identifyVideoDisplays().catch(() => undefined);
    }
  }, [stepName, available]);

  const preview = (next: VideoOutputSettings) => {
    previewedRef.current = true;
    setDraft(next);
    void applyVideoOutputSettings(next).catch(() => undefined);
  };

  // The check step projects the test pattern on the chosen display.
  useEffect(() => {
    if (stepName !== "check") return;
    preview({ ...draftRef.current, enabled: true });
    void showVideoTestPattern(true).catch(() => undefined);
    return () => {
      void showVideoTestPattern(false).catch(() => undefined);
    };
  }, [stepName]);

  const update = (patch: Partial<VideoOutputSettings>) => setDraft((previous) => ({ ...previous, ...patch }));

  const cancel = () => {
    if (previewedRef.current && originalRef.current) {
      void applyVideoOutputSettings(originalRef.current).catch(() => undefined);
    }
    closeWizard();
  };

  const finish = () => {
    void applyVideoOutputSettings({ ...draftRef.current, enabled: true }).catch(() => undefined);
    closeWizard();
  };

  const chooseDisplay = (display: VideoDisplayOption, mode: VideoOutputSettings["mode"]) =>
    update({
      display: { name: display.name, width: display.width, height: display.height, x: display.x, y: display.y },
      mode,
    });

  const pickIdleImage = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: t("transport.video.settings.imageFilter"), extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof picked === "string") preview({ ...draftRef.current, idle: { kind: "image", path: picked } });
  };

  const onlyOneDisplay = displays.length <= 1;
  const canGoNext =
    stepName === "welcome" ? available : stepName === "display" ? draft.display != null : true;

  const monitorAspect = draft.display && draft.display.height > 0 ? draft.display.width / draft.display.height : 16 / 9;
  const firstVideo = assets.find((asset) => asset.info.width > 0 && asset.info.height > 0);
  const videoAspect = firstVideo ? firstVideo.info.width / firstVideo.info.height : 16 / 9;

  return (
    <div className="lt-modal-backdrop">
      <section
        className="lt-settings-modal lt-video-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-video-wizard-title"
      >
        <header className="lt-settings-modal-header">
          <div>
            <h2 id="lt-video-wizard-title">{t(`transport.video.wizard.${stepName}.title`)}</h2>
            <p>{t("transport.video.wizard.progress", { step: step + 1, total: WIZARD_STEPS.length })}</p>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            aria-label={t("transport.video.wizard.cancel")}
            onClick={cancel}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="lt-video-wizard-body">
          {stepName === "welcome" ? (
            available ? (
              <p>{t("transport.video.wizard.welcome.body")}</p>
            ) : (
              <p className="is-error">
                {t("transport.video.settings.unavailable", { reason: mediaStatus?.reason ?? "?" })}
              </p>
            )
          ) : null}

          {stepName === "display" ? (
            <>
              <div className="lt-video-wizard-cards" role="radiogroup" aria-label={t("transport.video.settings.display")}>
                {displays.map((display) => (
                  <button
                    key={display.name}
                    type="button"
                    role="radio"
                    aria-checked={draft.display?.name === display.name}
                    className="lt-video-wizard-card"
                    onClick={() => chooseDisplay(display, onlyOneDisplay ? "window" : "fullscreen")}
                  >
                    <strong className="lt-video-wizard-card-number">{display.number}</strong>
                    <span>{shortDisplayName(display.name)}</span>
                    <small>{`${display.width}×${display.height}`}</small>
                    {display.hasApp ? <small>{t("transport.video.settings.hasApp")}</small> : null}
                  </button>
                ))}
              </div>
              {onlyOneDisplay ? (
                <div className="lt-video-wizard-note">
                  <p>{t("transport.video.wizard.display.oneMonitor")}</p>
                  {displays[0] ? (
                    <button type="button" onClick={() => chooseDisplay(displays[0], "window")}>
                      {t("transport.video.wizard.display.useWindow")}
                    </button>
                  ) : null}
                </div>
              ) : (
                <p>{t("transport.video.wizard.display.body")}</p>
              )}
            </>
          ) : null}

          {stepName === "check" ? (
            <>
              <p>{t("transport.video.wizard.check.body")}</p>
              <div className="lt-video-settings-row">
                <button type="button" onClick={() => setStep(step + 1)}>
                  {t("transport.video.wizard.check.yes")}
                </button>
                <button type="button" onClick={() => setStep(WIZARD_STEP_DISPLAY)}>
                  {t("transport.video.wizard.check.no")}
                </button>
              </div>
            </>
          ) : null}

          {stepName === "fit" ? (
            <>
              <div className="lt-video-wizard-fits" role="radiogroup" aria-label={t("transport.video.settings.fit")}>
                {FITS.map((fit) => {
                  const rect = fitPreviewRect(fit, monitorAspect, videoAspect, 120);
                  return (
                    <button
                      key={fit}
                      type="button"
                      role="radio"
                      aria-checked={draft.fit === fit}
                      className="lt-video-wizard-fit"
                      // Straight to the output, like the display step: the
                      // user sees the choice on the screen it is for.
                      onClick={() => preview({ ...draftRef.current, fit })}
                    >
                      <span className="lt-video-wizard-frame" style={{ width: 120, height: 120 / monitorAspect }}>
                        <span
                          className="lt-video-wizard-picture"
                          style={{ width: rect.width, height: rect.height }}
                        />
                      </span>
                      <span>{t(`transport.video.menu.fit${fit[0].toUpperCase()}${fit.slice(1)}`)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="lt-settings-field">
                <span>{t("transport.video.settings.idle")}</span>
                <div className="lt-video-settings-row">
                  <button type="button" aria-pressed={draft.idle.kind === "black"} onClick={() => preview({ ...draftRef.current, idle: { kind: "black" } })}>
                    {t("transport.video.settings.idleBlack")}
                  </button>
                  <button type="button" aria-pressed={draft.idle.kind === "image"} onClick={() => void pickIdleImage()}>
                    {t("transport.video.settings.idleImage")}
                  </button>
                  {draft.idle.kind === "image" ? <small>{shortDisplayName(draft.idle.path)}</small> : null}
                </div>
              </div>
            </>
          ) : null}

          {stepName === "sync" ? (
            <>
              <p>{t("transport.video.wizard.sync.body")}</p>
              <VideoCalibrationPanel
                canCalibrate
                latencyOffsetMs={draft.latencyOffsetMs}
                onApplyOffset={(offsetMs) => preview({ ...draftRef.current, latencyOffsetMs: offsetMs })}
              />
            </>
          ) : null}

          {stepName === "done" ? (
            <>
              <p>
                {t("transport.video.wizard.done.summary", {
                  display: draft.display ? shortDisplayName(draft.display.name) : "—",
                  mode: t(
                    draft.mode === "window"
                      ? "transport.video.settings.modeWindow"
                      : "transport.video.settings.modeFullscreen",
                  ),
                })}
              </p>
              <p>{t("transport.video.wizard.done.where")}</p>
            </>
          ) : null}
        </div>

        <footer className="lt-video-wizard-footer">
          <button type="button" onClick={cancel}>
            {t("transport.video.wizard.cancel")}
          </button>
          <span className="lt-video-wizard-spacer" />
          {step > 0 && stepName !== "done" ? (
            <button type="button" onClick={() => setStep(step - 1)}>
              {t("transport.video.wizard.back")}
            </button>
          ) : null}
          {stepName === "done" ? (
            <button type="button" className="is-primary" onClick={finish}>
              {t("transport.video.wizard.finish")}
            </button>
          ) : stepName === "check" ? null : (
            <button type="button" className="is-primary" disabled={!canGoNext} onClick={() => setStep(step + 1)}>
              {stepName === "sync" ? t("transport.video.wizard.sync.skip") : t("transport.video.wizard.next")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
