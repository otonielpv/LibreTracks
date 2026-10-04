import { useEffect, useState } from "react";

import {
  getMidiCapabilities,
  isTauriApp,
  listenToMidiDevicesChanged,
  type MidiCapabilities,
} from "../desktopApi";

/**
 * What MIDI can do on this platform (plan mobile-midi, paso 05).
 *
 * The UI decides which MIDI tabs and buttons to show from this, never from
 * "is this a phone": iOS and Android have MIDI now, and an Android device
 * without `android.software.midi` reports `available: false`. Re-read on
 * `midi:devices_changed` so a Bluetooth pairing or virtual port that changes
 * what is possible shows up without reopening Settings.
 *
 * `null` until the first answer arrives (and outside Tauri).
 */
export function useMidiCapabilities(): MidiCapabilities | null {
  const [capabilities, setCapabilities] = useState<MidiCapabilities | null>(
    null,
  );

  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const refresh = () => {
      void getMidiCapabilities()
        .then((next) => {
          if (!disposed) {
            setCapabilities(next);
          }
        })
        .catch(() => {});
    };

    refresh();
    void listenToMidiDevicesChanged(refresh).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    })
      // No event bridge (tests, a plain browser): nothing to follow.
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return capabilities;
}
