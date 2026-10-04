import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppSettings } from "@libretracks/shared/models";

import { isIOSApp, isMobileApp, pairBluetoothMidi } from "../desktopApi";
import { useMidiCapabilities } from "../hooks/useMidiCapabilities";
import { BluetoothMidiModal } from "./BluetoothMidiModal";

/**
 * The Settings modal's MIDI tab: input port (for MIDI learn) and output port
 * (for the timeline's MIDI tracks), plus a test-note button.
 *
 * Extracted from SettingsPanel rather than grown inside it — the panel is under
 * a size budget (see fileSizeBudget.test.ts) and the rule is to extract, not to
 * raise the limit. The tab is self-contained: every value it needs arrives as a
 * prop, so it holds no state of its own.
 *
 * On a phone or tablet (plan mobile-midi, paso 05) the selects go full width,
 * the test-note button gets a 44 px touch target (styles.css, `.lt-mobile
 * .lt-midi-settings`) and an empty device list explains how to connect one.
 */
export type MidiSettingsTabProps = {
  isLoading: boolean;
  isSaving: boolean;

  midiInputDevices: string[];
  isMidiInputRefreshing: boolean;
  selectedMidiInputDevice: string;
  selectedMidiInputDeviceMissing: boolean;
  onMidiInputDeviceChange: (value: string) => void;
  onRefreshMidiInputDevices: () => void;

  midiOutput: MidiOutputSettings;
};

/** The output port controls, grouped so they travel as one prop. */
export type MidiOutputSettings = {
  devices: string[];
  selected: string;
  selectedMissing: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
  onSendTestNote: () => void;
  /**
   * Platform MIDI settings (network session, our virtual port). They travel
   * with this group so the monolith's prop surface doesn't widen; the tab
   * shows each one only where `get_midi_capabilities` says it exists.
   */
  platform: MidiPlatformSettings;
};

export type MidiPlatformPatch = Partial<
  Pick<AppSettings, "midiNetworkSession" | "midiVirtualPort">
>;

export type MidiPlatformSettings = {
  networkSession: boolean;
  virtualPort: boolean;
  onChange: (patch: MidiPlatformPatch) => void;
};

export function MidiSettingsTab({
  isLoading,
  isSaving,
  midiInputDevices,
  isMidiInputRefreshing,
  selectedMidiInputDevice,
  selectedMidiInputDeviceMissing,
  onMidiInputDeviceChange,
  onRefreshMidiInputDevices,
  midiOutput,
}: MidiSettingsTabProps) {
  const {
    devices: midiOutputDevices,
    selected: selectedMidiOutputDevice,
    selectedMissing: selectedMidiOutputDeviceMissing,
    onChange: onMidiOutputDeviceChange,
    onRefresh: onRefreshMidiOutputDevices,
    onSendTestNote: onSendMidiTestNote,
    platform,
  } = midiOutput;
  const { t } = useTranslation();
  const capabilities = useMidiCapabilities();
  const [isBluetoothOpen, setIsBluetoothOpen] = useState(false);
  const [bluetoothError, setBluetoothError] = useState<string | null>(null);

  // iOS has a system pairing panel; Android gets our own scan modal.
  const openBluetooth = () => {
    if (!isIOSApp) {
      setIsBluetoothOpen(true);
      return;
    }
    setBluetoothError(null);
    void pairBluetoothMidi().catch((error: unknown) => {
      setBluetoothError(
        t("transport.midi.bluetoothFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  };

  return (
    <section
      className="lt-settings-tab-panel"
      role="tabpanel"
      id="lt-settings-panel-midi"
      aria-labelledby="lt-settings-tab-midi"
    >
      <div className="lt-settings-section-grid lt-midi-settings">
        {isMobileApp &&
        midiInputDevices.length === 0 &&
        midiOutputDevices.length === 0 ? (
          <p className="lt-midi-empty-help" role="note">
            {t("transport.midi.noDevicesMobile")}
          </p>
        ) : null}
        {capabilities?.bluetoothPairing ? (
          <div className="lt-settings-field">
            <button
              type="button"
              className="lt-ghost-button lt-midi-test-note"
              disabled={isLoading || isSaving}
              onClick={openBluetooth}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                bluetooth_searching
              </span>
              {t("transport.midi.bluetoothSearch")}
            </button>
            <small>{t("transport.midi.bluetoothHint")}</small>
            {bluetoothError ? (
              <small role="alert">{bluetoothError}</small>
            ) : null}
          </div>
        ) : null}
        {isBluetoothOpen ? (
          <BluetoothMidiModal onClose={() => setIsBluetoothOpen(false)} />
        ) : null}
        <div className="lt-settings-field">
          <label
            className="lt-settings-field-label"
            htmlFor="lt-midi-input-device"
          >
            {t("transport.settingsModal.midiDevice")}
          </label>
          <div className="lt-settings-field-control-row">
            <select
              id="lt-midi-input-device"
              value={selectedMidiInputDevice}
              disabled={
                isLoading || isSaving || isMidiInputRefreshing
              }
              onChange={(event) =>
                onMidiInputDeviceChange(event.target.value)
              }
            >
              <option value="">
                {t("transport.settingsModal.midiDeviceNone")}
              </option>
              {selectedMidiInputDeviceMissing ? (
                <option value={selectedMidiInputDevice}>
                  {t(
                    "transport.settingsModal.midiDeviceUnavailable",
                    { name: selectedMidiInputDevice },
                  )}
                </option>
              ) : null}
              {midiInputDevices.map((deviceName) => (
                <option key={deviceName} value={deviceName}>
                  {deviceName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="lt-settings-icon-button"
              aria-label={t(
                "transport.settingsModal.midiDeviceRefresh",
              )}
              title={t(
                "transport.settingsModal.midiDeviceRefresh",
              )}
              disabled={
                isLoading || isSaving || isMidiInputRefreshing
              }
              onClick={onRefreshMidiInputDevices}
            >
              <span className="material-symbols-outlined">
                refresh
              </span>
            </button>
          </div>
          <small>
            {t("transport.settingsModal.midiDeviceHelp")}
          </small>
        </div>

        {/* Output is a separate choice from input: sending to a
            lighting desk and receiving from a foot controller are
            unrelated devices. */}
        <div className="lt-settings-field">
          <label
            className="lt-settings-field-label"
            htmlFor="lt-midi-output-device"
          >
            {t("transport.midi.outputDevice")}
          </label>
          <div className="lt-settings-field-control-row">
            <select
              id="lt-midi-output-device"
              value={selectedMidiOutputDevice}
              disabled={isLoading || isSaving}
              onChange={(event) =>
                onMidiOutputDeviceChange(event.target.value)
              }
            >
              <option value="">
                {t("transport.midi.outputDeviceNone")}
              </option>
              {selectedMidiOutputDeviceMissing ? (
                <option value={selectedMidiOutputDevice}>
                  {t(
                    "transport.settingsModal.midiDeviceUnavailable",
                    { name: selectedMidiOutputDevice },
                  )}
                </option>
              ) : null}
              {midiOutputDevices.map((deviceName) => (
                <option key={deviceName} value={deviceName}>
                  {deviceName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="lt-settings-icon-button"
              aria-label={t(
                "transport.settingsModal.midiDeviceRefresh",
              )}
              title={t("transport.settingsModal.midiDeviceRefresh")}
              disabled={isLoading || isSaving}
              onClick={onRefreshMidiOutputDevices}
            >
              <span className="material-symbols-outlined">
                refresh
              </span>
            </button>
          </div>
          <div className="lt-settings-field-control-row">
            <button
              type="button"
              className="lt-ghost-button lt-midi-test-note"
              disabled={
                isLoading || isSaving || !selectedMidiOutputDevice
              }
              onClick={onSendMidiTestNote}
            >
              {t("transport.midi.testNote")}
            </button>
          </div>
          <small>{t("transport.midi.outputDeviceHint")}</small>
        </div>

        {capabilities?.virtualPorts ? (
          <label className="lt-settings-toggle">
            <input
              type="checkbox"
              checked={platform.virtualPort}
              disabled={isLoading || isSaving}
              onChange={(event) =>
                platform.onChange({ midiVirtualPort: event.target.checked })
              }
            />
            <span className="lt-settings-toggle-copy">
              <span>{t("transport.midi.virtualPort")}</span>
              <small>{t("transport.midi.virtualPortHint")}</small>
            </span>
          </label>
        ) : null}

        {capabilities?.networkSession ? (
          <label className="lt-settings-toggle">
            <input
              type="checkbox"
              checked={platform.networkSession}
              disabled={isLoading || isSaving}
              onChange={(event) =>
                platform.onChange({ midiNetworkSession: event.target.checked })
              }
            />
            <span className="lt-settings-toggle-copy">
              <span>{t("transport.midi.networkSession")}</span>
              <small>{t("transport.midi.networkSessionHint")}</small>
            </span>
          </label>
        ) : null}
      </div>
    </section>
  );
}
