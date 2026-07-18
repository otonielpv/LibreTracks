import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauriApp, listenToAudioDeviceStatus } from "./desktopApi";

/**
 * Output-device health badge for the transport bar.
 *
 * Fully self-contained: subscribes to the `audio:device_status` Tauri event
 * (emitted by the Rust device watchdog) and keeps its own state, so mounting
 * it inside the topbar adds no props and no re-renders to the transport tree.
 *
 * - Device lost (engine running on the internal fallback clock): shows a
 *   blinking "no audio output — reconnecting…" pill. Playback keeps running
 *   silently; the watchdog retries the device, no user action needed.
 * - Device recovered after an outage: shows a brief "audio restored" pill.
 * - Healthy (the usual state): renders nothing.
 */
export function AudioDeviceStatusBadge() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"ok" | "lost" | "restored">("ok");
  const restoredTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let sawOutage = false;

    void listenToAudioDeviceStatus((event) => {
      if (disposed) {
        return;
      }
      if (restoredTimerRef.current !== null) {
        window.clearTimeout(restoredTimerRef.current);
        restoredTimerRef.current = null;
      }
      if (event.fallbackActive) {
        sawOutage = true;
        setStatus("lost");
        return;
      }
      if (!sawOutage) {
        // Baseline "device is fine" event on startup — nothing to show.
        setStatus("ok");
        return;
      }
      sawOutage = false;
      setStatus("restored");
      restoredTimerRef.current = window.setTimeout(() => {
        restoredTimerRef.current = null;
        setStatus("ok");
      }, 4000);
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      if (restoredTimerRef.current !== null) {
        window.clearTimeout(restoredTimerRef.current);
        restoredTimerRef.current = null;
      }
      unlisten?.();
    };
  }, []);

  if (status === "ok") {
    return null;
  }

  if (status === "restored") {
    return (
      <span className="lt-device-status-pill is-restored" role="status">
        <span className="material-symbols-outlined" aria-hidden="true">
          volume_up
        </span>
        {t("timelineTopbar.deviceRestored")}
      </span>
    );
  }

  return (
    <span
      className="lt-device-status-pill is-lost"
      role="status"
      title={t("timelineTopbar.deviceLostTitle")}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        volume_off
      </span>
      {t("timelineTopbar.deviceLost")}
    </span>
  );
}
