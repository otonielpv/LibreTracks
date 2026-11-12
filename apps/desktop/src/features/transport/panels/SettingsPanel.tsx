import { useTranslation } from "react-i18next";
import { TOUR_TARGETS } from "../../tutorial/tourTargets";
import type { AppSettings, AudioDeviceDescriptor, MidiBinding } from "@libretracks/shared/models";
import { isAndroidApp, isMobileApp } from "@libretracks/shared/desktopApi";
import type {
  MidiLearnCommandRow,
  MidiLearnFeedback,
  SettingsTab,
} from "../types";
import { DiagnosticsSettingsTab } from "./DiagnosticsSettingsTab";
import { MulticoreAudioField } from "./MulticoreAudioField";
import { TrackMeterModeField } from "./TrackMeterModeField";
import { PlaybackSettingsFields } from "./PlaybackSettingsFields";
import { SettingsTabSection } from "./SettingsTabSection";
import { SettingsTabNav, settingsGroupLabel, type SettingsTabItem } from "./SettingsTabNav";
import { GeneralSettingsTab } from "./GeneralSettingsTab";
import { TimelineSettingsTab } from "./TimelineSettingsTab";
import { EditingSettingsTab } from "./EditingSettingsTab";
import { StorageSettingsTab } from "./StorageSettingsTab";
import { SystemSettingsTab } from "./SystemSettingsTab";
import { ShortcutsSettingsTab } from "./ShortcutsSettingsTab";
import { VideoSettingsTab } from "./VideoSettingsTab";
import { RedundancySettingsTab } from "../../redundancy/RedundancySettingsTab";
import {
  MidiSettingsTab,
  type MidiOutputSettings,
} from "./MidiSettingsTab";
import { MidiLearnSettingsTab, type MidiLearnView } from "./MidiLearnSettingsTab";
import { useDismissOnBack } from "../mobile/backNavigation";
import { useNetworkPermissions } from "../../network/useNetworkPermissions";

type AudioRoutingOption = { value: string; label: string };

/**
 * A network guest drives the host's session, not its own hardware or the
 * session's editing defaults: those tabs would show nothing they may change.
 */
const GUEST_HIDDEN_SETTINGS_TABS: readonly SettingsTab[] = ["midi", "midiLearn", "video", "editing"];

type SettingsPanelProps = {
  isOpen: boolean;
  onClose: () => void;

  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  settingsTabs: SettingsTabItem[];

  isLoading: boolean;
  isSaving: boolean;

  appSettings: AppSettings;

  audioBackendOptions: string[];
  audioDevicesForSelectedBackend: AudioDeviceDescriptor[];
  defaultAudioOutputDevice: string | null;
  selectedAudioOutputDevice: string;
  selectedAudioOutputDeviceMissing: boolean;
  selectedOutputChannelCount: number;
  outputSampleRateOptions: number[];
  autoOutputSampleRateLabel: string;
  outputBufferSizes: number[];
  audioRoutingOptions: AudioRoutingOption[];
  onAudioBackendChange: (value: string) => void;
  onAudioOutputDeviceChange: (value: string) => void;
  onRefreshAudioDevices: () => void;
  isAudioRefreshing: boolean;
  onOutputSampleRateChange: (value: string) => void;
  onOutputBufferSizeChange: (value: string) => void;
  onEnabledOutputChannelChange: (channelIndex: number, checked: boolean) => void;
  // Channel selection uses an explicit draft → apply model so that picking
  // ten channels doesn't trigger ten device reopens (each can take several
  // seconds on ASIO drivers).
  enabledOutputChannelsDraft: number[];
  enabledOutputChannelsDirty: boolean;
  onCommitEnabledOutputChannels: () => void;
  onDiscardEnabledOutputChannels: () => void;
  onSelectAllOutputChannels: () => void;
  onClearOutputChannels: () => void;
  onLowLatencyOutputChange: (checked: boolean) => void;
  onAudioSingleThreadRenderChange: (checked: boolean) => void;
  onTrackMeterModeChange: (mode: AppSettings["trackMeterMode"]) => void;

  midiInputDevices: string[];
  isMidiInputRefreshing: boolean;
  selectedMidiInputDevice: string;
  selectedMidiInputDeviceMissing: boolean;
  onMidiInputDeviceChange: (value: string) => void;
  onRefreshMidiInputDevices: () => void;

  /** Grouped so the MIDI tab's output controls travel as one prop. */
  midiOutput: MidiOutputSettings;

  selectedLocale: string;
  onLocaleChange: (value: string) => void;

  onTimelineNavigationSchemeChange: (value: "ableton" | "libretracks") => void;
  onTimelinePlayheadFollowModeChange: (
    value: AppSettings["timelinePlayheadFollowMode"],
  ) => void;
  onPauseAtSongEndChange: (value: boolean) => void;
  onVampBetweenSongsChange: (value: boolean) => void;
  onFadeOutStopSecondsChange: (value: number) => void;
  onSongTrackLayoutChange: (value: AppSettings["songTrackLayout"]) => void;
  onDefaultSongTemplateChange: (value: string | null) => void;
  onReferenceImportedAudioChange: (value: boolean) => void;
  onAutoColorNewTracksChange: (value: boolean) => void;
  onAutoWarpChange: (value: boolean) => void;
  onAutoSaveEnabledChange: (value: boolean) => void;
  onAutoSaveIntervalMinutesChange: (value: number) => void;

  midiLearnMode: string | null;
  midiLearnFeedback: MidiLearnFeedback | null;
  midiLearnFeedbackCommand: MidiLearnCommandRow | null;
  midiLearnView: MidiLearnView;
  onMidiLearnViewChange: (view: MidiLearnView) => void;
  midiLearnMarkerRows: MidiLearnCommandRow[];
  midiLearnSongRows: MidiLearnCommandRow[];
  visibleMidiLearnRows: MidiLearnCommandRow[];
  activeMidiLearnCommand: MidiLearnCommandRow | null;
  onMidiLearnToggle: (options?: { closePanels?: boolean }) => void;
  onResetMidiMappings: () => void;
  onMidiBindingChange: (key: string, binding: MidiBinding | null) => void;
  onApplyControllerProfile: (
    mappings: Record<string, MidiBinding>,
    controllerOutput: string | null,
  ) => void;
  formatMidiLearnCommandLabel: (key: string) => string;
  onMidiLearnCommandRelearn: (key: string) => void;
  onDynamicMidiLearnJump: (type: "marker" | "song") => void;
  onMidiLearnTarget: (key: string) => void;
};

export function SettingsPanel({
  isOpen,
  onClose,
  activeTab: requestedTab,
  onTabChange,
  settingsTabs: allTabs,
  isLoading,
  isSaving,
  appSettings,
  audioBackendOptions,
  audioDevicesForSelectedBackend,
  defaultAudioOutputDevice,
  selectedAudioOutputDevice,
  selectedAudioOutputDeviceMissing,
  selectedOutputChannelCount,
  outputSampleRateOptions,
  autoOutputSampleRateLabel,
  outputBufferSizes,
  audioRoutingOptions,
  onAudioBackendChange,
  onAudioOutputDeviceChange,
  onRefreshAudioDevices,
  isAudioRefreshing,
  onOutputSampleRateChange,
  onOutputBufferSizeChange,
  onEnabledOutputChannelChange,
  enabledOutputChannelsDraft,
  enabledOutputChannelsDirty,
  onCommitEnabledOutputChannels,
  onDiscardEnabledOutputChannels,
  onSelectAllOutputChannels,
  onClearOutputChannels,
  onLowLatencyOutputChange,
  onAudioSingleThreadRenderChange,
  onTrackMeterModeChange,
  midiInputDevices,
  isMidiInputRefreshing,
  selectedMidiInputDevice,
  selectedMidiInputDeviceMissing,
  onMidiInputDeviceChange,
  onRefreshMidiInputDevices,
  midiOutput,
  selectedLocale,
  onLocaleChange,
  onTimelineNavigationSchemeChange,
  onTimelinePlayheadFollowModeChange,
  onPauseAtSongEndChange,
  onVampBetweenSongsChange,
  onFadeOutStopSecondsChange,
  onSongTrackLayoutChange,
  onDefaultSongTemplateChange,
  onReferenceImportedAudioChange,
  onAutoColorNewTracksChange,
  onAutoWarpChange,
  onAutoSaveEnabledChange,
  onAutoSaveIntervalMinutesChange,
  midiLearnMode,
  midiLearnFeedback,
  midiLearnFeedbackCommand,
  midiLearnView,
  onMidiLearnViewChange,
  midiLearnMarkerRows,
  midiLearnSongRows,
  visibleMidiLearnRows,
  activeMidiLearnCommand,
  onMidiLearnToggle,
  onResetMidiMappings,
  onMidiBindingChange,
  onApplyControllerProfile,
  formatMidiLearnCommandLabel,
  onMidiLearnCommandRelearn,
  onDynamicMidiLearnJump,
  onMidiLearnTarget,
}: SettingsPanelProps) {
  // En Android, atras cierra este overlay en vez de salir de la aplicacion.
  useDismissOnBack(onClose, isOpen);
  const { t } = useTranslation();
  const { isGuest, canControl, canEdit } = useNetworkPermissions();
  const settingsTabs = isGuest
    ? allTabs.filter((tab) => !GUEST_HIDDEN_SETTINGS_TABS.includes(tab.id))
    : allTabs;
  const activeTab = settingsTabs.some((tab) => tab.id === requestedTab) ? requestedTab : "general";
  const activeTabMeta = settingsTabs.find((tab) => tab.id === activeTab);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="lt-modal-backdrop">
      <section
        className="lt-settings-modal lt-settings-modal--fixed"
        data-lt-tour={TOUR_TARGETS.settingsModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-settings-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            {/* The active section, not a fixed "Audio": the eyebrow used to
                read "Audio" on every tab. */}
            <span className="lt-settings-modal-eyebrow">
              {activeTabMeta
                ? activeTabMeta.group
                  ? `${settingsGroupLabel(t, activeTabMeta.group)} · ${activeTabMeta.label}`
                  : activeTabMeta.label
                : t("transport.settingsModal.eyebrow")}
            </span>
            <h2 id="lt-settings-modal-title">
              {t("transport.settingsModal.title")}
            </h2>
            <p>{t("transport.settingsModal.description")}</p>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            data-lt-tour={TOUR_TARGETS.settingsClose}
            onClick={onClose}
          >
            <span className="material-symbols-outlined">close</span>
            {t("transport.settingsModal.close")}
          </button>
        </header>

        <div className="lt-settings-modal-body">
          <div className="lt-settings-tabs">
            <SettingsTabNav
              tabs={settingsTabs}
              activeTab={activeTab}
              onTabChange={onTabChange}
            />

            <div className="lt-settings-tab-panels">
              {activeTab === "audio" ? (
                <section
                  className="lt-settings-tab-panel"
                  role="tabpanel"
                  id="lt-settings-panel-audio"
                  aria-labelledby="lt-settings-tab-audio"
                >
                  <div className="lt-settings-section-grid">
                    {!isGuest ? <>
                    {/* Android has exactly one audio backend (Oboe/AAudio), so
                        the "Audio System" selector is noise there — hide it and
                        show only the device / rate / buffer controls. */}
                    {!isMobileApp ? (
                      <label className="lt-settings-field">
                        <span className="lt-settings-field-label">
                          {t("transport.settingsModal.audioBackend", {
                            defaultValue: "Audio System",
                          })}
                        </span>
                        <select
                          value={appSettings.selectedAudioBackend ?? ""}
                          disabled={isSaving}
                          onChange={(event) =>
                            onAudioBackendChange(event.target.value)
                          }
                        >
                          <option value="">
                            {t(
                              "transport.settingsModal.audioBackendSystemDefault",
                              { defaultValue: "System default" },
                            )}
                          </option>
                          {audioBackendOptions.map((backend) => (
                            <option key={backend} value={backend}>
                              {backend.replaceAll("_", " ").toUpperCase()}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.audioDevice")}
                      </span>
                      <select
                        value={selectedAudioOutputDevice}
                        disabled={isSaving}
                        onChange={(event) =>
                          onAudioOutputDeviceChange(event.target.value)
                        }
                      >
                        <option value="">
                          {defaultAudioOutputDevice
                            ? t(
                                "transport.settingsModal.audioDeviceSystemDefaultNamed",
                                { name: defaultAudioOutputDevice },
                              )
                            : t(
                                "transport.settingsModal.audioDeviceSystemDefault",
                              )}
                        </option>
                        {selectedAudioOutputDeviceMissing ? (
                          <option value={selectedAudioOutputDevice}>
                            {t(
                              "transport.settingsModal.audioDeviceUnavailable",
                              {
                                name:
                                  appSettings.selectedOutputDeviceName ??
                                  selectedAudioOutputDevice,
                              },
                            )}
                          </option>
                        ) : null}
                        {audioDevicesForSelectedBackend.map((device) => (
                          <option key={device.stableId} value={device.stableId}>
                            {device.name}
                          </option>
                        ))}
                      </select>
                      <small>
                        {appSettings.selectedOutputDeviceId
                          ? t(
                              "transport.settingsModal.audioDeviceExplicitHelp",
                              {
                                defaultValue:
                                  "Explicit selections open this device directly; the Windows default is ignored.",
                              },
                            )
                          : defaultAudioOutputDevice
                            ? t(
                                "transport.settingsModal.audioDeviceCurrentDefault",
                                { name: defaultAudioOutputDevice },
                              )
                            : t(
                                "transport.settingsModal.audioDeviceNoDefault",
                              )}
                      </small>
                    </label>

                    <div className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t(
                          "transport.settingsModal.audioDeviceRefreshLabel",
                          { defaultValue: "Device list" },
                        )}
                      </span>
                      <button
                        type="button"
                        className="lt-secondary-button"
                        disabled={isLoading || isSaving || isAudioRefreshing}
                        onClick={onRefreshAudioDevices}
                      >
                        {isAudioRefreshing ? (
                          <>
                            <span
                              className="material-symbols-outlined lt-spin"
                              aria-hidden="true"
                            >
                              progress_activity
                            </span>
                            {t(
                              "transport.settingsModal.audioDeviceRefreshing",
                              { defaultValue: "Refreshing…" },
                            )}
                          </>
                        ) : (
                          t("transport.settingsModal.audioDeviceRefresh", {
                            defaultValue: "Refresh audio devices",
                          })
                        )}
                      </button>
                    </div>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.sampleRate", {
                          defaultValue: "Sample Rate",
                        })}
                      </span>
                      <select
                        value={appSettings.outputSampleRate ?? ""}
                        disabled={isSaving}
                        onChange={(event) =>
                          onOutputSampleRateChange(event.target.value)
                        }
                      >
                        <option value="">{autoOutputSampleRateLabel}</option>
                        {outputSampleRateOptions.map((sampleRate) => (
                          <option key={sampleRate} value={sampleRate}>
                            {sampleRate} Hz
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.bufferSize", {
                          defaultValue: "Buffer Size",
                        })}
                      </span>
                      <select
                        value={
                          typeof appSettings.outputBufferSize === "object" &&
                          "fixed" in appSettings.outputBufferSize
                            ? String(appSettings.outputBufferSize.fixed)
                            : ""
                        }
                        disabled={isSaving}
                        onChange={(event) =>
                          onOutputBufferSizeChange(event.target.value)
                        }
                      >
                        <option value="">
                          {t(
                            "transport.settingsModal.audioDeviceSystemDefault",
                          )}
                        </option>
                        {outputBufferSizes.map((bufferSize) => (
                          <option key={bufferSize} value={bufferSize}>
                            {bufferSize}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="lt-settings-field">
                      <div className="lt-output-channel-header">
                        <span className="lt-settings-field-label">
                          {t(
                            "transport.settingsModal.hardwareOutputs",
                            { defaultValue: "Hardware Outputs" },
                          )}
                        </span>
                        <div className="lt-output-channel-bulk">
                          <button
                            type="button"
                            disabled={
                              isSaving ||
                              enabledOutputChannelsDraft.length ===
                                selectedOutputChannelCount
                            }
                            onClick={onSelectAllOutputChannels}
                          >
                            {t(
                              "transport.settingsModal.selectAllChannels",
                              { defaultValue: "Select all" },
                            )}
                          </button>
                          <button
                            type="button"
                            disabled={
                              isSaving ||
                              enabledOutputChannelsDraft.length === 0
                            }
                            onClick={onClearOutputChannels}
                          >
                            {t(
                              "transport.settingsModal.clearChannels",
                              { defaultValue: "Clear" },
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="lt-output-channel-grid">
                        {Array.from(
                          { length: selectedOutputChannelCount },
                          (_, channelIndex) => (
                            <label
                              key={channelIndex}
                              className="lt-settings-checkbox"
                            >
                              <input
                                type="checkbox"
                                checked={enabledOutputChannelsDraft.includes(
                                  channelIndex,
                                )}
                                disabled={isSaving}
                                onChange={(event) =>
                                  onEnabledOutputChannelChange(
                                    channelIndex,
                                    event.target.checked,
                                  )
                                }
                              />
                              <span>
                                {t(
                                  "transport.settingsModal.hardwareOutputChannel",
                                  {
                                    channel: channelIndex + 1,
                                    defaultValue: `Channel ${channelIndex + 1}`,
                                  },
                                )}
                              </span>
                            </label>
                          ),
                        )}
                      </div>
                      <div className="lt-inline-actions lt-output-channel-actions">
                        <button
                          type="button"
                          className="is-primary"
                          disabled={isSaving || !enabledOutputChannelsDirty}
                          onClick={onCommitEnabledOutputChannels}
                        >
                          {t(
                            "transport.settingsModal.applyChannels",
                            { defaultValue: "Apply" },
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={isSaving || !enabledOutputChannelsDirty}
                          onClick={onDiscardEnabledOutputChannels}
                        >
                          {t(
                            "transport.settingsModal.discardChannels",
                            { defaultValue: "Discard" },
                          )}
                        </button>
                        <span className="lt-output-channel-actions-hint">
                          {enabledOutputChannelsDirty
                            ? t(
                                "transport.settingsModal.channelsPendingHint",
                                {
                                  defaultValue:
                                    "Pending changes — the audio device reopens on Apply.",
                                },
                              )
                            : t(
                                "transport.settingsModal.channelsAppliedHint",
                                {
                                  defaultValue: "All changes applied.",
                                },
                              )}
                        </span>
                      </div>
                    </div>

                    {/* Low-latency mode is an Android/AAudio-only knob; desktop
                        backends negotiate latency through buffer size. */}
                    {isAndroidApp ? (
                      <label className="lt-settings-toggle">
                        <input
                          type="checkbox"
                          checked={appSettings.lowLatencyOutput}
                          disabled={isSaving}
                          onChange={(event) =>
                            onLowLatencyOutputChange(event.target.checked)
                          }
                        />
                        <span className="lt-settings-toggle-copy">
                          <span>
                            {t("transport.settingsModal.lowLatencyOutput", {
                              defaultValue: "Baja latencia",
                            })}
                          </span>
                          <small>
                            {t("transport.settingsModal.lowLatencyOutputHint", {
                              defaultValue:
                                "Menor retardo con interfaces de audio; puede dar cortes en dispositivos modestos.",
                            })}
                          </small>
                        </span>
                      </label>
                    ) : null}

                    <MulticoreAudioField
                      singleThreadRender={appSettings.audioSingleThreadRender}
                      disabled={isSaving}
                      onSingleThreadRenderChange={
                        onAudioSingleThreadRenderChange
                      }
                    />
                    </> : null}
                    <TrackMeterModeField
                      mode={appSettings.trackMeterMode}
                      disabled={isSaving || !canEdit}
                      onModeChange={onTrackMeterModeChange}
                    />
                  </div>
                </section>
              ) : null}

              {activeTab === "midi" ? (
                <MidiSettingsTab
                  isLoading={isLoading}
                  isSaving={isSaving}
                  midiInputDevices={midiInputDevices}
                  isMidiInputRefreshing={isMidiInputRefreshing}
                  selectedMidiInputDevice={selectedMidiInputDevice}
                  selectedMidiInputDeviceMissing={selectedMidiInputDeviceMissing}
                  onMidiInputDeviceChange={onMidiInputDeviceChange}
                  onRefreshMidiInputDevices={onRefreshMidiInputDevices}
                  midiOutput={midiOutput}
                />
              ) : null}

              {activeTab === "general" ? (
                <GeneralSettingsTab
                  selectedLocale={selectedLocale}
                  onLocaleChange={onLocaleChange}
                  disabled={isLoading || isSaving}
                />
              ) : null}

              {activeTab === "timeline" ? (
                <TimelineSettingsTab
                  settings={appSettings}
                  disabled={isLoading || isSaving}
                  onTimelineNavigationSchemeChange={onTimelineNavigationSchemeChange}
                  onTimelinePlayheadFollowModeChange={onTimelinePlayheadFollowModeChange}
                />
              ) : null}

              {activeTab === "playback" ? (
                <SettingsTabSection id="playback">
                  <PlaybackSettingsFields
                    settings={appSettings}
                    disabled={isLoading || isSaving || !canControl}
                    onPauseAtSongEndChange={onPauseAtSongEndChange}
                    onVampBetweenSongsChange={onVampBetweenSongsChange}
                    onFadeOutStopSecondsChange={onFadeOutStopSecondsChange}
                  />
                </SettingsTabSection>
              ) : null}

              {activeTab === "editing" ? (
                <EditingSettingsTab
                  appSettings={appSettings}
                  disabled={isLoading || isSaving}
                  onSongTrackLayoutChange={onSongTrackLayoutChange}
                  onDefaultSongTemplateChange={onDefaultSongTemplateChange}
                  onReferenceImportedAudioChange={onReferenceImportedAudioChange}
                  onAutoColorNewTracksChange={onAutoColorNewTracksChange}
                  onAutoWarpChange={onAutoWarpChange}
                  onAutoSaveEnabledChange={onAutoSaveEnabledChange}
                  onAutoSaveIntervalMinutesChange={onAutoSaveIntervalMinutesChange}
                />
              ) : null}

              {activeTab === "storage" ? <StorageSettingsTab isGuest={isGuest} /> : null}

              {activeTab === "system" ? <SystemSettingsTab /> : null}

              {activeTab === "shortcuts" ? <ShortcutsSettingsTab /> : null}
              {activeTab === "video" ? <VideoSettingsTab /> : null}
              {activeTab === "redundancy" ? <RedundancySettingsTab /> : null}

              {activeTab === "diagnostics" ? (
                <section
                  className="lt-settings-tab-panel"
                  role="tabpanel"
                  id="lt-settings-panel-diagnostics"
                  aria-labelledby="lt-settings-tab-diagnostics"
                >
                  <DiagnosticsSettingsTab />
                </section>
              ) : null}

              {activeTab === "midiLearn" ? (
                <MidiLearnSettingsTab
                  layout={isMobileApp ? "list" : "table"}
                  isLoading={isLoading}
                  isSaving={isSaving}
                  hasMappings={Object.keys(appSettings.midiMappings).length > 0}
                  midiLearnMode={midiLearnMode}
                  midiLearnFeedback={midiLearnFeedback}
                  midiLearnFeedbackCommand={midiLearnFeedbackCommand}
                  midiLearnView={midiLearnView}
                  onMidiLearnViewChange={onMidiLearnViewChange}
                  midiLearnMarkerRows={midiLearnMarkerRows}
                  midiLearnSongRows={midiLearnSongRows}
                  visibleMidiLearnRows={visibleMidiLearnRows}
                  activeMidiLearnCommand={activeMidiLearnCommand}
                  onMidiLearnToggle={onMidiLearnToggle}
                  onResetMidiMappings={onResetMidiMappings}
                  onMidiLearnCommandRelearn={onMidiLearnCommandRelearn}
                  onDynamicMidiLearnJump={onDynamicMidiLearnJump}
                  midiMappings={appSettings.midiMappings}
                  onMidiBindingChange={onMidiBindingChange}
                  onApplyControllerProfile={onApplyControllerProfile}
                  selectedMidiInput={selectedMidiInputDevice || null}
                  formatCommandLabel={formatMidiLearnCommandLabel}
                />
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
