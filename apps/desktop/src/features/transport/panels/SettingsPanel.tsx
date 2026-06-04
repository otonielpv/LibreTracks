import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, AudioDeviceDescriptor } from "@libretracks/shared/models";
import {
  METRONOME_SOUND_PRESETS,
  METRONOME_SUBDIVISIONS,
} from "@libretracks/shared/models";
import { readErrorLog, revealErrorLog } from "@libretracks/shared/desktopApi";
import type {
  MidiLearnCommandRow,
  MidiLearnFeedback,
  SettingsTab,
} from "../types";
import { formatMidiBinding } from "../helpers";
import {
  isNewerVersion,
  normalizeVersion,
} from "../../../shared/updateCheck";
import {
  openUpdateModal,
  runUpdateCheck,
  useUpdateCheckStore,
} from "../../updates/updateCheckStore";

type AudioRoutingOption = { value: string; label: string };

type SettingsPanelProps = {
  isOpen: boolean;
  onClose: () => void;

  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  settingsTabs: Array<{ id: SettingsTab; label: string }>;

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
  onAudioSafeModeChange: (checked: boolean) => void;

  metronomeVolumeDraft: number;
  onMetronomeEnabledChange: (checked: boolean) => void;
  onMetronomeOutputChange: (value: string) => void;
  onMetronomeVolumeDraftChange: (value: number) => void;
  onCommitMetronomeVolume: (value: number) => void;
  onMetronomeSoundChange: (patch: Partial<AppSettings>) => void;

  midiInputDevices: string[];
  isMidiInputRefreshing: boolean;
  selectedMidiInputDevice: string;
  selectedMidiInputDeviceMissing: boolean;
  onMidiInputDeviceChange: (value: string) => void;
  onRefreshMidiInputDevices: () => void;

  selectedLocale: string;
  onLocaleChange: (value: string) => void;

  onTimelineNavigationSchemeChange: (value: "ableton" | "libretracks") => void;

  midiLearnMode: string | null;
  midiLearnFeedback: MidiLearnFeedback | null;
  midiLearnFeedbackCommand: MidiLearnCommandRow | null;
  midiLearnView: "core" | "markers" | "songs";
  onMidiLearnViewChange: (view: "core" | "markers" | "songs") => void;
  midiLearnMarkerRows: MidiLearnCommandRow[];
  midiLearnSongRows: MidiLearnCommandRow[];
  visibleMidiLearnRows: MidiLearnCommandRow[];
  activeMidiLearnCommand: MidiLearnCommandRow | null;
  onMidiLearnToggle: (options?: { closePanels?: boolean }) => void;
  onResetMidiMappings: () => void;
  onMidiLearnCommandRelearn: (key: string) => void;
  onDynamicMidiLearnJump: (type: "marker" | "song") => void;
  onMidiLearnTarget: (key: string) => void;
};

export function SettingsPanel({
  isOpen,
  onClose,
  activeTab,
  onTabChange,
  settingsTabs,
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
  onOutputSampleRateChange,
  onOutputBufferSizeChange,
  onEnabledOutputChannelChange,
  enabledOutputChannelsDraft,
  enabledOutputChannelsDirty,
  onCommitEnabledOutputChannels,
  onDiscardEnabledOutputChannels,
  onSelectAllOutputChannels,
  onClearOutputChannels,
  onAudioSafeModeChange,
  metronomeVolumeDraft,
  onMetronomeEnabledChange,
  onMetronomeOutputChange,
  onMetronomeVolumeDraftChange,
  onCommitMetronomeVolume,
  onMetronomeSoundChange,
  midiInputDevices,
  isMidiInputRefreshing,
  selectedMidiInputDevice,
  selectedMidiInputDeviceMissing,
  onMidiInputDeviceChange,
  onRefreshMidiInputDevices,
  selectedLocale,
  onLocaleChange,
  onTimelineNavigationSchemeChange,
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
  onMidiLearnCommandRelearn,
  onDynamicMidiLearnJump,
  onMidiLearnTarget,
}: SettingsPanelProps) {
  const { t } = useTranslation();

  if (!isOpen) {
    return null;
  }

  return (
    <div className="lt-modal-backdrop">
      <section
        className="lt-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-settings-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.settingsModal.eyebrow")}
            </span>
            <h2 id="lt-settings-modal-title">
              {t("transport.settingsModal.title")}
            </h2>
            <p>{t("transport.settingsModal.description")}</p>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            onClick={onClose}
          >
            <span className="material-symbols-outlined">close</span>
            {t("transport.settingsModal.close")}
          </button>
        </header>

        <div className="lt-settings-modal-body">
          <div className="lt-settings-tabs">
            <div
              className="lt-settings-tablist"
              role="tablist"
              aria-label={t("transport.settingsModal.tabListLabel", {
                defaultValue: "Settings sections",
              })}
            >
              {settingsTabs.map((tab) => {
                const isActive = activeTab === tab.id;

                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`lt-settings-tab-${tab.id}`}
                    className={`lt-settings-tab-button ${isActive ? "is-active" : ""}`}
                    aria-selected={isActive}
                    aria-controls={`lt-settings-panel-${tab.id}`}
                    onClick={() => onTabChange(tab.id)}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="lt-settings-tab-panels">
              {activeTab === "audio" ? (
                <section
                  className="lt-settings-tab-panel"
                  role="tabpanel"
                  id="lt-settings-panel-audio"
                  aria-labelledby="lt-settings-tab-audio"
                >
                  <div className="lt-settings-section-grid">
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
                        disabled={isSaving}
                        onClick={onRefreshAudioDevices}
                      >
                        {t(
                          "transport.settingsModal.audioDeviceRefresh",
                          { defaultValue: "Refresh audio devices" },
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

                    <label className="lt-settings-toggle">
                      <input
                        type="checkbox"
                        checked={appSettings.audioSafeMode}
                        disabled={isSaving}
                        onChange={(event) =>
                          onAudioSafeModeChange(event.target.checked)
                        }
                      />
                      <span>
                        {t("transport.settingsModal.audioSafeMode", {
                          defaultValue: "Safe Mode",
                        })}
                      </span>
                    </label>
                  </div>
                </section>
              ) : null}

              {activeTab === "metronome" ? (
                <section
                  className="lt-settings-tab-panel"
                  role="tabpanel"
                  id="lt-settings-panel-metronome"
                  aria-labelledby="lt-settings-tab-metronome"
                >
                  <div className="lt-settings-section-grid">
                    <label className="lt-settings-toggle">
                      <input
                        type="checkbox"
                        checked={appSettings.metronomeEnabled}
                        disabled={isLoading || isSaving}
                        onPointerDown={(event) => {
                          if (midiLearnMode === null) {
                            return;
                          }

                          event.preventDefault();
                          event.stopPropagation();
                          onMidiLearnTarget("action:toggle_metronome");
                        }}
                        onChange={(event) =>
                          onMetronomeEnabledChange(event.target.checked)
                        }
                      />
                      <div className="lt-settings-toggle-copy">
                        <strong>{t("transport.shell.metronome")}</strong>
                        <small>
                          {t(
                            "transport.settingsModal.metronomeStatusDescription",
                            {
                              defaultValue: "Toggle the metronome playback.",
                            },
                          )}
                        </small>
                      </div>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t(
                          "transport.settingsModal.metronomeOutput",
                          { defaultValue: "Metronome Output" },
                        )}
                      </span>
                      <select
                        value={appSettings.metronomeOutput}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onMetronomeOutputChange(event.target.value)
                        }
                      >
                        {audioRoutingOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.metronomeVolume")}
                      </span>
                      <input
                        className="lt-range-input"
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={metronomeVolumeDraft}
                        disabled={isLoading || isSaving}
                        onPointerDown={(event) => {
                          if (midiLearnMode === null) {
                            return;
                          }

                          event.preventDefault();
                          event.stopPropagation();
                          onMidiLearnTarget("param:metronome_volume");
                        }}
                        onChange={(event) =>
                          onMetronomeVolumeDraftChange(
                            Number(event.target.value),
                          )
                        }
                        onPointerUp={(event) =>
                          onCommitMetronomeVolume(
                            Number(event.currentTarget.value),
                          )
                        }
                        onBlur={(event) =>
                          onCommitMetronomeVolume(
                            Number(event.currentTarget.value),
                          )
                        }
                      />
                      <small>
                        {t(
                          "transport.settingsModal.metronomeVolumeValue",
                          {
                            value: Math.round(metronomeVolumeDraft * 100),
                          },
                        )}
                      </small>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.metronomeAccentSound", {
                          defaultValue: "Accent sound",
                        })}
                      </span>
                      <select
                        value={appSettings.metronomeAccentPreset}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onMetronomeSoundChange({
                            metronomeAccentPreset: Number(event.target.value),
                          })
                        }
                      >
                        {METRONOME_SOUND_PRESETS.map((preset, index) => (
                          <option key={preset} value={index}>
                            {t(`transport.settingsModal.metronomePreset.${preset}`, {
                              defaultValue: preset,
                            })}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.metronomeAccentPitch", {
                          defaultValue: "Accent pitch",
                        })}
                      </span>
                      <input
                        className="lt-range-input"
                        type="range"
                        min={-24}
                        max={24}
                        step={1}
                        value={appSettings.metronomeAccentPitch}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onMetronomeSoundChange({
                            metronomeAccentPitch: Number(event.target.value),
                          })
                        }
                      />
                      <small>
                        {t("transport.settingsModal.metronomePitchValue", {
                          defaultValue: "{{value}} st",
                          value: appSettings.metronomeAccentPitch,
                        })}
                      </small>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.metronomeBeatSound", {
                          defaultValue: "Beat sound",
                        })}
                      </span>
                      <select
                        value={appSettings.metronomeBeatPreset}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onMetronomeSoundChange({
                            metronomeBeatPreset: Number(event.target.value),
                          })
                        }
                      >
                        {METRONOME_SOUND_PRESETS.map((preset, index) => (
                          <option key={preset} value={index}>
                            {t(`transport.settingsModal.metronomePreset.${preset}`, {
                              defaultValue: preset,
                            })}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.metronomeBeatPitch", {
                          defaultValue: "Beat pitch",
                        })}
                      </span>
                      <input
                        className="lt-range-input"
                        type="range"
                        min={-24}
                        max={24}
                        step={1}
                        value={appSettings.metronomeBeatPitch}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onMetronomeSoundChange({
                            metronomeBeatPitch: Number(event.target.value),
                          })
                        }
                      />
                      <small>
                        {t("transport.settingsModal.metronomePitchValue", {
                          defaultValue: "{{value}} st",
                          value: appSettings.metronomeBeatPitch,
                        })}
                      </small>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.metronomeSubdivision", {
                          defaultValue: "Subdivision",
                        })}
                      </span>
                      <select
                        value={appSettings.metronomeSubdivision}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onMetronomeSoundChange({
                            metronomeSubdivision: Number(event.target.value),
                          })
                        }
                      >
                        {METRONOME_SUBDIVISIONS.map((value) => (
                          <option key={value} value={value}>
                            {t(`transport.settingsModal.metronomeSubdivisionOption.${value}`, {
                              defaultValue:
                                value === 1 ? "Off" : `1/${value}`,
                            })}
                          </option>
                        ))}
                      </select>
                    </label>

                    {appSettings.metronomeSubdivision > 1 ? (
                      <>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">
                            {t("transport.settingsModal.metronomeSubdivisionSound", {
                              defaultValue: "Subdivision sound",
                            })}
                          </span>
                          <select
                            value={appSettings.metronomeSubdivisionPreset}
                            disabled={isLoading || isSaving}
                            onChange={(event) =>
                              onMetronomeSoundChange({
                                metronomeSubdivisionPreset: Number(
                                  event.target.value,
                                ),
                              })
                            }
                          >
                            {METRONOME_SOUND_PRESETS.map((preset, index) => (
                              <option key={preset} value={index}>
                                {t(`transport.settingsModal.metronomePreset.${preset}`, {
                                  defaultValue: preset,
                                })}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">
                            {t("transport.settingsModal.metronomeSubdivisionPitch", {
                              defaultValue: "Subdivision pitch",
                            })}
                          </span>
                          <input
                            className="lt-range-input"
                            type="range"
                            min={-24}
                            max={24}
                            step={1}
                            value={appSettings.metronomeSubdivisionPitch}
                            disabled={isLoading || isSaving}
                            onChange={(event) =>
                              onMetronomeSoundChange({
                                metronomeSubdivisionPitch: Number(
                                  event.target.value,
                                ),
                              })
                            }
                          />
                          <small>
                            {t("transport.settingsModal.metronomePitchValue", {
                              defaultValue: "{{value}} st",
                              value: appSettings.metronomeSubdivisionPitch,
                            })}
                          </small>
                        </label>

                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">
                            {t("transport.settingsModal.metronomeSubdivisionGain", {
                              defaultValue: "Subdivision volume",
                            })}
                          </span>
                          <input
                            className="lt-range-input"
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={appSettings.metronomeSubdivisionGain}
                            disabled={isLoading || isSaving}
                            onChange={(event) =>
                              onMetronomeSoundChange({
                                metronomeSubdivisionGain: Number(
                                  event.target.value,
                                ),
                              })
                            }
                          />
                          <small>
                            {t("transport.settingsModal.metronomeVolumeValue", {
                              value: Math.round(
                                appSettings.metronomeSubdivisionGain * 100,
                              ),
                            })}
                          </small>
                        </label>
                      </>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {activeTab === "midi" ? (
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
                  </div>
                </section>
              ) : null}

              {activeTab === "general" ? (
                <section
                  className="lt-settings-tab-panel"
                  role="tabpanel"
                  id="lt-settings-panel-general"
                  aria-labelledby="lt-settings-tab-general"
                >
                  <div className="lt-settings-section-grid">
                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.language")}
                      </span>
                      <select
                        value={selectedLocale}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onLocaleChange(event.target.value)
                        }
                      >
                        <option value="">
                          {t(
                            "transport.settingsModal.languageSystemDefault",
                          )}
                        </option>
                        <option value="en">
                          {t("transport.settingsModal.languageEnglish")}
                        </option>
                        <option value="es">
                          {t("transport.settingsModal.languageSpanish")}
                        </option>
                      </select>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.timelineNavigationScheme", {
                          defaultValue: "Timeline navigation",
                        })}
                      </span>
                      <select
                        value={appSettings.timelineNavigationScheme}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onTimelineNavigationSchemeChange(
                            event.target.value === "libretracks"
                              ? "libretracks"
                              : "ableton",
                          )
                        }
                      >
                        <option value="ableton">
                          {t(
                            "transport.settingsModal.timelineNavigationSchemeAbleton",
                            {
                              defaultValue:
                                "Ableton / Audacity (pinch to zoom, scroll to pan)",
                            },
                          )}
                        </option>
                        <option value="libretracks">
                          {t(
                            "transport.settingsModal.timelineNavigationSchemeLibreTracks",
                            {
                              defaultValue:
                                "LibreTracks classic (scroll wheel zooms)",
                            },
                          )}
                        </option>
                      </select>
                      <small>
                        {t(
                          "transport.settingsModal.timelineNavigationSchemeHelp",
                          {
                            defaultValue:
                              "Choose how the trackpad / mouse wheel moves around the timeline. In Ableton mode, pinch (or Ctrl + scroll) zooms toward the cursor and Alt + scroll resizes track height.",
                          },
                        )}
                      </small>
                    </label>

                    <UpdateCheckField />
                  </div>
                </section>
              ) : null}

              {activeTab === "diagnostics" ? (
                <section
                  className="lt-settings-tab-panel"
                  role="tabpanel"
                  id="lt-settings-panel-diagnostics"
                  aria-labelledby="lt-settings-tab-diagnostics"
                >
                  <DiagnosticsTabPanel />
                </section>
              ) : null}

              {activeTab === "midiLearn" ? (
                <section
                  className="lt-settings-tab-panel"
                  role="tabpanel"
                  id="lt-settings-panel-midiLearn"
                  aria-labelledby="lt-settings-tab-midiLearn"
                >
                  <section
                    className="lt-midi-learn-panel"
                    aria-labelledby="lt-midi-learn-panel-title"
                  >
                    <div className="lt-midi-learn-panel-header">
                      <div>
                        <span
                          id="lt-midi-learn-panel-title"
                          className="lt-settings-field-label"
                        >
                          {t(
                            "transport.settingsModal.midiLearnSectionTitle",
                          )}
                        </span>
                        <p>
                          {t(
                            "transport.settingsModal.midiLearnSectionDescription",
                          )}
                        </p>
                      </div>
                      <div className="lt-midi-learn-actions">
                        <button
                          type="button"
                          className={`lt-midi-learn-activate ${midiLearnMode !== null ? "is-active" : ""}`}
                          disabled={isLoading || isSaving}
                          onClick={() =>
                            onMidiLearnToggle({ closePanels: false })
                          }
                        >
                          <span className="material-symbols-outlined">
                            graphic_eq
                          </span>
                          {t("transport.shell.midiLearn")}
                        </button>
                        <button
                          type="button"
                          className="lt-midi-learn-reset"
                          disabled={
                            isLoading ||
                            isSaving ||
                            Object.keys(appSettings.midiMappings).length === 0
                          }
                          onClick={onResetMidiMappings}
                        >
                          {t("transport.settingsModal.midiLearnReset")}
                        </button>
                      </div>
                    </div>

                    <div className="lt-midi-learn-feedback">
                      <strong>
                        {t("transport.settingsModal.midiLearnLatest")}
                      </strong>
                      {midiLearnFeedback ? (
                        <p>
                          {midiLearnFeedbackCommand?.label ??
                            midiLearnFeedback.key}
                          :{" "}
                          {formatMidiBinding(midiLearnFeedback.binding)}
                        </p>
                      ) : (
                        <p>
                          {t("transport.settingsModal.midiLearnEmpty")}
                        </p>
                      )}
                    </div>

                    {midiLearnMode !== null ? (
                      <div className="lt-midi-learn-live">
                        <strong>
                          {t(
                            "transport.settingsModal.midiLearnListening",
                          )}
                        </strong>
                        <p>
                          {midiLearnMode === ""
                            ? t("transport.settingsModal.midiLearnArmed")
                            : t(
                                "transport.settingsModal.midiLearnTargeting",
                                {
                                  key:
                                    activeMidiLearnCommand?.label ??
                                    midiLearnMode,
                                },
                              )}
                        </p>
                      </div>
                    ) : null}

                    <div className="lt-segmented-control lt-midi-learn-view-tabs">
                      <button
                        type="button"
                        className={
                          midiLearnView === "core" ? "is-active" : ""
                        }
                        onClick={() => onMidiLearnViewChange("core")}
                      >
                        {t("transport.settingsModal.midiLearnViewCore")}
                      </button>
                      <button
                        type="button"
                        className={
                          midiLearnView === "markers" ? "is-active" : ""
                        }
                        onClick={() => onMidiLearnViewChange("markers")}
                      >
                        {t(
                          "transport.settingsModal.midiLearnViewMarkers",
                          {
                            count: midiLearnMarkerRows.length,
                          },
                        )}
                      </button>
                      <button
                        type="button"
                        className={
                          midiLearnView === "songs" ? "is-active" : ""
                        }
                        onClick={() => onMidiLearnViewChange("songs")}
                      >
                        {t(
                          "transport.settingsModal.midiLearnViewSongs",
                          {
                            count: midiLearnSongRows.length,
                          },
                        )}
                      </button>
                    </div>

                    <div className="lt-midi-learn-table-wrap">
                      <table className="lt-midi-learn-table">
                        <thead>
                          <tr>
                            <th scope="col">
                              {t(
                                "transport.settingsModal.midiLearnTableCommand",
                              )}
                            </th>
                            <th scope="col">
                              {t(
                                "transport.settingsModal.midiLearnTableBinding",
                              )}
                            </th>
                            <th scope="col">
                              {t(
                                "transport.settingsModal.midiLearnTableAction",
                              )}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleMidiLearnRows.map((command) => {
                            const hasBinding = Boolean(command.binding);
                            const isTarget = midiLearnMode === command.key;

                            return (
                              <tr
                                key={command.key}
                                className={
                                  isTarget ? "is-midi-target" : undefined
                                }
                              >
                                <td>
                                  <strong>{command.label}</strong>
                                  <code>{command.key}</code>
                                </td>
                                <td>
                                  {hasBinding && command.binding ? (
                                    <span className="lt-midi-binding-pill">
                                      {formatMidiBinding(command.binding)}
                                    </span>
                                  ) : (
                                    <span className="lt-midi-binding-empty">
                                      {t(
                                        "transport.settingsModal.midiLearnUnassigned",
                                      )}
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className={`lt-midi-learn-relearn ${isTarget ? "is-active" : ""}`}
                                    disabled={isLoading || isSaving}
                                    onClick={() =>
                                      onMidiLearnCommandRelearn(command.key)
                                    }
                                  >
                                    {isTarget
                                      ? t(
                                          "transport.settingsModal.midiLearnListeningShort",
                                        )
                                      : t(
                                          "transport.settingsModal.midiLearnRelearn",
                                        )}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="lt-midi-learn-dynamic-actions">
                      {midiLearnView === "markers" ? (
                        <button
                          type="button"
                          className="lt-midi-learn-map-jump"
                          disabled={isLoading || isSaving}
                          onClick={() => onDynamicMidiLearnJump("marker")}
                        >
                          {t(
                            "transport.settingsModal.midiLearnMapMarkerJump",
                          )}
                        </button>
                      ) : null}
                      {midiLearnView === "songs" ? (
                        <button
                          type="button"
                          className="lt-midi-learn-map-jump"
                          disabled={isLoading || isSaving}
                          onClick={() => onDynamicMidiLearnJump("song")}
                        >
                          {t(
                            "transport.settingsModal.midiLearnMapSongJump",
                          )}
                        </button>
                      ) : null}
                    </div>
                  </section>
                </section>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function UpdateCheckField() {
  const { t } = useTranslation();
  const { release, error, isChecking, hasCheckedOnce } = useUpdateCheckStore();
  const current = normalizeVersion(
    typeof window !== "undefined"
      ? (window as { __LT_APP_VERSION__?: string }).__LT_APP_VERSION__ ?? ""
      : "",
  );
  const remoteIsNewer =
    release && current ? isNewerVersion(release.version, current) : false;

  let statusLine: ReactNode = null;
  if (error) {
    statusLine = (
      <small className="lt-update-check-status lt-update-check-status--error">
        {t("update.checkError", { message: error })}
      </small>
    );
  } else if (release && remoteIsNewer) {
    statusLine = (
      <small className="lt-update-check-status lt-update-check-status--new">
        {t("update.available", { version: release.version })}{" "}
        <button
          type="button"
          className="lt-update-check-link"
          onClick={openUpdateModal}
        >
          {t("update.viewDetails")}
        </button>
      </small>
    );
  } else if (hasCheckedOnce && current) {
    statusLine = (
      <small className="lt-update-check-status">
        {t("update.upToDate", { version: current })}
      </small>
    );
  }

  return (
    <div className="lt-settings-field">
      <span className="lt-settings-field-label">{t("update.checkNow")}</span>
      <button
        type="button"
        className="lt-secondary-button"
        disabled={isChecking}
        onClick={() => {
          void runUpdateCheck({ force: true });
        }}
      >
        {isChecking ? t("update.checking") : t("update.checkNow")}
      </button>
      {statusLine}
    </div>
  );
}

function DiagnosticsTabPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReactNode>(null);

  const handleReveal = () => {
    void revealErrorLog().catch((error) => {
      setStatus(
        <small className="lt-update-check-status lt-update-check-status--error">
          {error instanceof Error ? error.message : String(error)}
        </small>,
      );
    });
  };

  const handleCopy = () => {
    void (async () => {
      try {
        const contents = await readErrorLog();
        if (!contents.trim()) {
          setStatus(
            <small className="lt-update-check-status">
              {t("transport.settingsModal.diagnosticsEmpty", {
                defaultValue: "No errors have been recorded yet.",
              })}
            </small>,
          );
          return;
        }
        await navigator.clipboard.writeText(contents);
        setStatus(
          <small className="lt-update-check-status lt-update-check-status--new">
            {t("transport.settingsModal.diagnosticsCopied", {
              defaultValue: "Error log copied to clipboard.",
            })}
          </small>,
        );
      } catch (error) {
        setStatus(
          <small className="lt-update-check-status lt-update-check-status--error">
            {error instanceof Error ? error.message : String(error)}
          </small>,
        );
      }
    })();
  };

  return (
    <div className="lt-settings-section-grid">
      <div className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.diagnosticsTitle", {
            defaultValue: "Error log",
          })}
        </span>
        <small>
          {t("transport.settingsModal.diagnosticsDescription", {
            defaultValue:
              "If the app freezes or misbehaves, send us this log so we can find the cause. It records errors only — no audio or personal data.",
          })}
        </small>
        <div className="lt-inline-actions">
          <button
            type="button"
            className="lt-secondary-button"
            onClick={handleReveal}
          >
            {t("transport.settingsModal.diagnosticsOpenFolder", {
              defaultValue: "Open logs folder",
            })}
          </button>
          <button
            type="button"
            className="lt-secondary-button"
            onClick={handleCopy}
          >
            {t("transport.settingsModal.diagnosticsCopy", {
              defaultValue: "Copy error log",
            })}
          </button>
        </div>
        {status}
      </div>
    </div>
  );
}
