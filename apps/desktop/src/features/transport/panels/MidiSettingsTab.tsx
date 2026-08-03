import { useTranslation } from "react-i18next";

/**
 * The Settings modal's MIDI tab: input port (for MIDI learn) and output port
 * (for the timeline's MIDI tracks), plus a test-note button.
 *
 * Extracted from SettingsPanel rather than grown inside it — the panel is under
 * a size budget (see fileSizeBudget.test.ts) and the rule is to extract, not to
 * raise the limit. The tab is self-contained: every value it needs arrives as a
 * prop, so it holds no state of its own.
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
  } = midiOutput;
  const { t } = useTranslation();

  return (
    <section
      className="lt-settings-tab-panel"
      role="tabpanel"
      id="lt-settings-panel-midi"
      aria-labelledby="lt-settings-tab-midi"
    >
      <div className="lt-settings-section-grid">
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
              className="lt-ghost-button"
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
      </div>
    </section>
  );
}
