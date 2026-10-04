import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  appendFrontendError,
  isTauriApp,
  listenToAudioIdleWake,
  reopenAudioOutput,
  takeAudioIdleWake,
} from "./desktopApi";

/**
 * "Resume" prompt after a long idle suspension (Android).
 *
 * With the app in the background and nothing playing, the engine pauses its
 * output stream so the phone can sleep. A stream paused for a long gap (from
 * rehearsal to the service) came back silent once: the playhead moved and
 * nothing was heard until the app was restarted. Back from a suspension that
 * long, this asks the user to resume, which reopens the output device from
 * scratch, the same thing the restart did.
 *
 * Self-contained like AudioDeviceStatusBadge: the Rust side raises a flag and
 * an `audio:idle_wake` event; the flag is also polled when the page becomes
 * visible, in case the event fired before the WebView was listening.
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
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
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
