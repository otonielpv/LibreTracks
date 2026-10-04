import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  BLUETOOTH_MIDI_ERRORS,
  connectBluetoothMidi,
  scanBluetoothMidi,
  type BluetoothMidiDevice,
} from "../desktopApi";
import { useDismissOnBack } from "../mobile/backNavigation";

/**
 * Android's Bluetooth LE MIDI search (plan mobile-midi, paso 06). iOS has a
 * system panel for this; Android does not, so the app scans for the BLE MIDI
 * service (~10 s), lists what it found and connects the one the user taps.
 * The device then appears in the MIDI input/output lists like a USB one, and
 * is reopened on every launch.
 */
type ScanState =
  | { kind: "scanning" }
  | { kind: "results"; devices: BluetoothMidiDevice[] }
  | { kind: "error"; message: string };

function errorMessage(
  error: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes(BLUETOOTH_MIDI_ERRORS.permissionDenied)) {
    return t("transport.midi.bluetoothPermissionDenied");
  }
  if (text.includes(BLUETOOTH_MIDI_ERRORS.bluetoothOff)) {
    return t("transport.midi.bluetoothOff");
  }
  return t("transport.midi.bluetoothFailed", { error: text });
}

export function BluetoothMidiModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [scan, setScan] = useState<ScanState>({ kind: "scanning" });
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const disposedRef = useRef(false);

  // Stable callback for the Android back stack (see MidiRouteModal).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onBack = useCallback(() => onCloseRef.current(), []);
  useDismissOnBack(onBack);

  const runScan = useCallback(() => {
    setScan({ kind: "scanning" });
    void scanBluetoothMidi()
      .then((devices) => {
        if (!disposedRef.current) {
          setScan({ kind: "results", devices });
        }
      })
      .catch((error: unknown) => {
        if (!disposedRef.current) {
          setScan({ kind: "error", message: errorMessage(error, t) });
        }
      });
  }, [t]);

  useEffect(() => {
    disposedRef.current = false;
    runScan();
    return () => {
      disposedRef.current = true;
    };
  }, [runScan]);

  const connect = (device: BluetoothMidiDevice) => {
    setConnecting(device.address);
    void connectBluetoothMidi(device.address)
      .then(() => {
        if (!disposedRef.current) {
          setConnected(device.name);
        }
      })
      .catch((error: unknown) => {
        if (!disposedRef.current) {
          setScan({ kind: "error", message: errorMessage(error, t) });
        }
      })
      .finally(() => {
        if (!disposedRef.current) {
          setConnecting(null);
        }
      });
  };

  return (
    <div className="lt-modal-backdrop" onClick={onClose}>
      <section
        className="lt-settings-modal lt-bluetooth-midi-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-bluetooth-midi-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.midi.modalEyebrow")}
            </span>
            <h2 id="lt-bluetooth-midi-title">
              {t("transport.midi.bluetoothTitle")}
            </h2>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-midi-settings">
          {connected ? (
            <p className="lt-midi-empty-help" role="status">
              {t("transport.midi.bluetoothConnected", { name: connected })}
            </p>
          ) : null}

          {scan.kind === "scanning" ? (
            <p className="lt-midi-empty-help" role="status">
              {t("transport.midi.bluetoothScanning")}
            </p>
          ) : null}

          {scan.kind === "error" ? (
            <p className="lt-midi-empty-help" role="alert">
              {scan.message}
            </p>
          ) : null}

          {scan.kind === "results" && scan.devices.length === 0 ? (
            <p className="lt-midi-empty-help" role="status">
              {t("transport.midi.bluetoothNoneFound")}
            </p>
          ) : null}

          {scan.kind === "results" && scan.devices.length > 0 ? (
            <ul className="lt-midi-learn-list">
              {scan.devices.map((device) => (
                <li key={device.address}>
                  <div className="lt-midi-learn-list-text">
                    <strong>{device.name}</strong>
                    <span className="lt-midi-binding-empty">{device.address}</span>
                  </div>
                  <button
                    type="button"
                    className="lt-midi-learn-relearn"
                    disabled={connecting !== null}
                    aria-label={`${t("transport.midi.bluetoothConnect")}: ${device.name}`}
                    onClick={() => connect(device)}
                  >
                    {connecting === device.address
                      ? t("transport.midi.bluetoothConnecting")
                      : t("transport.midi.bluetoothConnect")}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="lt-inline-actions lt-automation-modal-actions">
          <button
            type="button"
            className="lt-secondary-button"
            disabled={scan.kind === "scanning"}
            onClick={runScan}
          >
            {t("transport.midi.bluetoothScanAgain")}
          </button>
          <button type="button" className="is-primary" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </section>
    </div>
  );
}
