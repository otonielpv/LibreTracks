import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getMidiStatus,
  isTauriApp,
  listenToMidiDevicesChanged,
  type MidiDevicesStatus,
} from "./desktopApi";

/**
 * MIDI device health badge for the transport bar (plan mobile-midi, paso 04).
 *
 * Self-contained like `AudioDeviceStatusBadge`: reads `get_midi_status` once
 * and then follows `midi:devices_changed`, so it adds no props to the
 * transport tree. It only shows while a selected MIDI port is missing — the
 * backend reopens it by itself when the device comes back, so the pill just
 * explains why the pedal does nothing right now.
 */
export function MidiDeviceStatusBadge() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MidiDevicesStatus | null>(null);

  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listenToMidiDevicesChanged((next) => {
      if (!disposed) {
        setStatus(next);
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    });
    void getMidiStatus()
      .then((initial) => {
        if (!disposed) {
          setStatus((current) => current ?? initial);
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!status || (!status.inputWaiting && !status.outputWaiting)) {
    return null;
  }

  const label = status.inputWaiting
    ? t("timelineTopbar.midiInputWaiting")
    : t("timelineTopbar.midiOutputWaiting");

  return (
    <span
      className="lt-device-status-pill is-lost"
      role="status"
      aria-label={label}
      title={t("timelineTopbar.midiWaitingTitle")}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        piano_off
      </span>
      {label}
    </span>
  );
}
