import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_VIDEO_OUTPUT_SETTINGS,
  applyVideoOutputSettings,
  getSettings,
  isIOSApp,
  listVideoDisplays,
  listenToVideoDisplays,
  showVideoTestPattern,
  type VideoDisplayOption,
  type VideoOutputSettings,
} from "../desktopApi";
import { useDismissOnBack } from "../mobile/backNavigation";
import { useVideoStore } from "./videoStore";

/** How long "waiting for a display" waits before explaining what to check. */
export const MOBILE_DISPLAY_HELP_MS = 20_000;

/** Mounted on phones; renders nothing until the store opens the wizard. */
export function VideoSetupWizardMobile() {
  const wizardOpen = useVideoStore((state) => state.wizardOpen);
  return wizardOpen ? <MobileWizardDialog /> : null;
}

/**
 * The phone's display setup (plan video-mobile, paso 10 §2): two screens
 * instead of the desktop's six. "Connect the cable" switches the output on
 * and waits for the native side to report an external display (help after
 * 20 s); "Check the picture" projects the test pattern. There is no display
 * to pick by number: the first external one is used unless one is pinned in
 * Settings → Video.
 */
function MobileWizardDialog() {
  const { t } = useTranslation();
  const closeWizard = useVideoStore((state) => state.closeWizard);
  const [step, setStep] = useState<"connect" | "check">("connect");
  const [displays, setDisplays] = useState<VideoDisplayOption[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const foundRef = useRef<VideoOutputSettings | null>(null);

  // Switch the output on (keeping a pinned display) and listen for displays.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getSettings()
      .then((appSettings) => {
        const current = { ...DEFAULT_VIDEO_OUTPUT_SETTINGS, ...(appSettings.videoOutput ?? {}) };
        foundRef.current = current;
        if (!current.enabled) {
          void applyVideoOutputSettings({ ...current, enabled: true }).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    void listVideoDisplays()
      .then((list) => {
        if (!disposed) setDisplays(list);
      })
      .catch(() => undefined);
    void listenToVideoDisplays((list) => setDisplays(list))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // A display appeared: on to the picture.
  useEffect(() => {
    if (step === "connect" && displays.length > 0) setStep("check");
  }, [displays, step]);

  // Nothing after a while: say what to check, for this platform.
  useEffect(() => {
    setShowHelp(false);
    if (step !== "connect") return;
    const timer = window.setTimeout(() => setShowHelp(true), MOBILE_DISPLAY_HELP_MS);
    return () => window.clearTimeout(timer);
  }, [step]);

  // The test pattern while checking.
  useEffect(() => {
    if (step !== "check") return;
    void showVideoTestPattern(true).catch(() => undefined);
    return () => {
      void showVideoTestPattern(false).catch(() => undefined);
    };
  }, [step]);

  const cancel = useCallback(() => {
    const found = foundRef.current;
    if (found && !found.enabled) {
      void applyVideoOutputSettings(found).catch(() => undefined);
    }
    closeWizard();
  }, [closeWizard]);
  useDismissOnBack(cancel);

  const display = displays[0];
  return (
    <div className="lt-modal-backdrop">
      <section
        className="lt-settings-modal lt-video-wizard is-mobile"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-video-wizard-mobile-title"
      >
        {step === "connect" ? (
          <>
            <header className="lt-settings-modal-header">
              <h2 id="lt-video-wizard-mobile-title">{t("transport.video.wizard.mobile.connectTitle")}</h2>
            </header>
            <div className="lt-video-wizard-body">
              <p>{t("transport.video.wizard.mobile.connectBody")}</p>
              <p role="status">{t("transport.video.wizard.mobile.waiting")}</p>
              {showHelp ? (
                <div className="lt-video-mobile-help" data-testid="video-wizard-help">
                  <strong>{t("transport.video.wizard.mobile.noDisplayHelp")}</strong>
                  <p>
                    {t(
                      isIOSApp
                        ? "transport.video.settings.mobileHelpIos"
                        : "transport.video.settings.mobileHelpAndroid",
                    )}
                  </p>
                </div>
              ) : null}
            </div>
            <footer className="lt-video-wizard-footer">
              <button type="button" onClick={cancel}>
                {t("transport.video.wizard.cancel")}
              </button>
            </footer>
          </>
        ) : (
          <>
            <header className="lt-settings-modal-header">
              <h2 id="lt-video-wizard-mobile-title">{t("transport.video.wizard.mobile.checkTitle")}</h2>
            </header>
            <div className="lt-video-wizard-body">
              {display ? <p>{t("transport.video.wizard.mobile.found", { name: display.name })}</p> : null}
              <p>{t("transport.video.wizard.mobile.checkBody")}</p>
              {showHelp ? (
                <div className="lt-video-mobile-help" data-testid="video-wizard-help">
                  <p>
                    {t(
                      isIOSApp
                        ? "transport.video.settings.mobileHelpIos"
                        : "transport.video.settings.mobileHelpAndroid",
                    )}
                  </p>
                </div>
              ) : null}
            </div>
            <footer className="lt-video-wizard-footer">
              <button type="button" onClick={cancel}>
                {t("transport.video.wizard.cancel")}
              </button>
              <button type="button" onClick={() => setShowHelp(true)}>
                {t("transport.video.wizard.mobile.no")}
              </button>
              <span className="lt-video-wizard-spacer" />
              <button type="button" className="is-primary" onClick={() => closeWizard()}>
                {t("transport.video.wizard.mobile.yes")}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
