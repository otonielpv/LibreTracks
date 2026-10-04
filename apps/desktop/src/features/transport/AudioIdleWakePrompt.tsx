import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  appendFrontendError,
  isTauriApp,
  listenToAudioIdleWake,
  reopenAudioOutput,
  setAppHidden,
  takeAudioIdleWake,
} from "./desktopApi";

/**
 * "Resume" prompt after a long idle spell, on every platform.
 *
 * An Android user left the app open from rehearsal to the service; at Play
 * the playhead moved and nothing was heard until the app was restarted. Back
 * from a long spell away (background, minimised, hidden) or from a system
 * sleep with nothing sounding, this asks the user to resume, which reopens the
 * output device from scratch, the same thing the restart did. It never
 * presses Play: a paused or stopped transport stays as it was.
 *
 * Rust decides (audio/wake_prompt.rs) and raises a flag plus an
 * `audio:idle_wake` event; the flag is also polled when the page becomes
 * visible, in case the event fired before the WebView was listening. This
 * component reports the page's visibility, which is how desktop and iOS know
 * the app is away (Android hears it from the activity).
 */
export function AudioIdleWakePrompt() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const check = () => {
      void takeAudioIdleWake()
        .then((pending) => {
          if (pending && !disposed) {
            setFailed(false);
            setOpen(true);
          }
        })
        .catch(() => {});
    };
    const reportVisibility = () => {
      const hidden = document.visibilityState !== "visible";
      void setAppHidden(hidden).catch(() => {});
      return hidden;
    };
    const onVisibility = () => {
      if (!reportVisibility()) {
        check();
      }
    };

    void listenToAudioIdleWake(check).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    });
    document.addEventListener("visibilitychange", onVisibility);
    reportVisibility();
    check();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      unlisten?.();
    };
  }, []);

  const handleResume = useCallback(() => {
    setBusy(true);
    setFailed(false);
    void reopenAudioOutput()
      .then(() => {
        setOpen(false);
      })
      .catch((error: unknown) => {
        setFailed(true);
        void appendFrontendError(
          `idle wake: reopening the audio output failed; error=${String(error)}`,
        ).catch(() => {});
      })
      .finally(() => {
        setBusy(false);
      });
  }, []);

  if (!open) {
    return null;
  }

  return (
    <div
      className="lt-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lt-idle-wake-title"
    >
      <div className="lt-settings-modal lt-settings-modal--compact">
        <header className="lt-settings-modal-header">
          <div>
            <h2 id="lt-idle-wake-title">{t("idleWake.title")}</h2>
            <p>{failed ? t("idleWake.failed") : t("idleWake.body")}</p>
          </div>
        </header>
        <footer className="lt-update-modal-actions">
          {failed ? (
            <button
              type="button"
              className="lt-settings-modal-close"
              onClick={() => setOpen(false)}
            >
              {t("idleWake.close")}
            </button>
          ) : null}
          <button
            type="button"
            className="lt-settings-modal-close lt-update-modal-primary"
            onClick={handleResume}
            disabled={busy}
            autoFocus
          >
            {busy ? t("idleWake.resuming") : t("idleWake.resume")}
          </button>
        </footer>
      </div>
    </div>
  );
}
