import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TOUR_TARGETS } from "../../tutorial/tourTargets";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings, AudioDeviceDescriptor } from "@libretracks/shared/models";
import { AUTO_SAVE_INTERVAL_PRESETS } from "@libretracks/shared/models";
import type { DecodingCacheInfo } from "@libretracks/shared/desktopApi";
import {
  getDecodingCacheInfo,
  isAndroidApp,
  isMobileApp,
  purgeDecodingCache,
  setDecodingCacheDir,
  setDecodingCacheMaxGb,
} from "@libretracks/shared/desktopApi";
import type {
  MidiLearnCommandRow,
  MidiLearnFeedback,
  SettingsTab,
} from "../types";
import { formatMidiBinding } from "../helpers";
import { formatUserFacingError } from "../errors/formatTransportError";
import { UI_ZOOM_STEPS, setUiZoom, useUiZoom } from "../../../shared/uiZoom";
import { TelemetrySettingsField } from "../../telemetry/TelemetryController";
import { DiagnosticsSettingsTab } from "./DiagnosticsSettingsTab";
import { MulticoreAudioField } from "./MulticoreAudioField";
import { UpdateCheckField } from "./UpdateCheckField";
import { ShortcutsSettingsTab } from "./ShortcutsSettingsTab";
import {
  MidiSettingsTab,
  type MidiOutputSettings,
} from "./MidiSettingsTab";

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
  onAudioSafeModeChange: (checked: boolean) => void;
  onLowLatencyOutputChange: (checked: boolean) => void;
  onAudioSingleThreadRenderChange: (checked: boolean) => void;

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
  onImportMergeMatchingTracksChange: (value: boolean) => void;
  onAutoSaveEnabledChange: (value: boolean) => void;
  onAutoSaveIntervalMinutesChange: (value: number) => void;

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
  onAudioSafeModeChange,
  onLowLatencyOutputChange,
  onAudioSingleThreadRenderChange,
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
  onImportMergeMatchingTracksChange,
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
        className="lt-settings-modal lt-settings-modal--fixed"
        data-lt-tour={TOUR_TARGETS.settingsModal}
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
            data-lt-tour={TOUR_TARGETS.settingsClose}
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

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t(
                          "transport.settingsModal.timelinePlayheadFollowMode",
                          {
                            defaultValue: "Playhead follow",
                          },
                        )}
                      </span>
                      <select
                        value={appSettings.timelinePlayheadFollowMode}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onTimelinePlayheadFollowModeChange(
                            event.target.value === "center"
                              ? "center"
                              : "ahead",
                          )
                        }
                      >
                        <option value="ahead">
                          {t(
                            "transport.settingsModal.timelinePlayheadFollowModeAhead",
                            {
                              defaultValue: "Keep ahead (75% of the view)",
                            },
                          )}
                        </option>
                        <option value="center">
                          {t(
                            "transport.settingsModal.timelinePlayheadFollowModeCenter",
                            {
                              defaultValue: "Centered",
                            },
                          )}
                        </option>
                      </select>
                      <small>
                        {t(
                          "transport.settingsModal.timelinePlayheadFollowModeHelp",
                          {
                            defaultValue:
                              "Choose where the cursor sits when follow is enabled in the timeline toolbar.",
                          },
                        )}
                      </small>
                    </label>

                    <label className="lt-settings-toggle">
                      <input
                        type="checkbox"
                        checked={appSettings.importMergeMatchingTracks}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onImportMergeMatchingTracksChange(
                            event.target.checked,
                          )
                        }
                      />
                      <span className="lt-settings-toggle-copy">
                        <span>
                          {t(
                            "transport.settingsModal.importMergeMatchingTracks",
                            {
                              defaultValue:
                                "Unir pistas con el mismo nombre al importar",
                            },
                          )}
                        </span>
                        <small>
                          {t(
                            "transport.settingsModal.importMergeMatchingTracksHint",
                            {
                              defaultValue:
                                "Al importar una canción, sus clips se añaden a la pista existente que ya tenga ese nombre. Desactívalo para que cada canción traiga sus propias pistas.",
                            },
                          )}
                        </small>
                      </span>
                    </label>

                    <label className="lt-settings-toggle">
                      <input
                        type="checkbox"
                        checked={appSettings.autoSaveEnabled}
                        disabled={isLoading || isSaving}
                        onChange={(event) =>
                          onAutoSaveEnabledChange(event.target.checked)
                        }
                      />
                      <span className="lt-settings-toggle-copy">
                        <span>
                          {t("transport.settingsModal.autoSave", {
                            defaultValue: "Guardar automáticamente",
                          })}
                        </span>
                        <small>
                          {t("transport.settingsModal.autoSaveHint", {
                            defaultValue:
                              "Guarda la sesión abierta cada cierto tiempo para que un fallo inesperado no se lleve tu trabajo. Solo guarda si has cambiado algo, y nunca durante la reproducción.",
                          })}
                        </small>
                      </span>
                    </label>

                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.settingsModal.autoSaveInterval", {
                          defaultValue: "Guardar cada",
                        })}
                      </span>
                      <select
                        value={appSettings.autoSaveIntervalMinutes}
                        disabled={
                          isLoading || isSaving || !appSettings.autoSaveEnabled
                        }
                        onChange={(event) =>
                          onAutoSaveIntervalMinutesChange(
                            Number(event.target.value),
                          )
                        }
                      >
                        {/* A settings file may hold a value that is not one of
                            the presets (hand-edited, or a preset we dropped);
                            surface it so the select still shows the truth. */}
                        {!AUTO_SAVE_INTERVAL_PRESETS.includes(
                          appSettings.autoSaveIntervalMinutes,
                        ) ? (
                          <option value={appSettings.autoSaveIntervalMinutes}>
                            {t("transport.settingsModal.autoSaveIntervalMinutes", {
                              defaultValue: "{{count}} min",
                              count: appSettings.autoSaveIntervalMinutes,
                            })}
                          </option>
                        ) : null}
                        {AUTO_SAVE_INTERVAL_PRESETS.map((minutes) => (
                          <option key={minutes} value={minutes}>
                            {t("transport.settingsModal.autoSaveIntervalMinutes", {
                              defaultValue: "{{count}} min",
                              count: minutes,
                            })}
                          </option>
                        ))}
                      </select>
                    </label>

                    <InterfaceZoomField />

                    <DecodingCacheField />

                    <UpdateCheckField />

                    <TelemetrySettingsField />
                  </div>
                </section>
              ) : null}

              {activeTab === "shortcuts" ? <ShortcutsSettingsTab /> : null}

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

function formatCacheBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit <= 1 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Ableton-style "Decoding Cache" controls: the folder where decoded `.rf64`
 * PCM caches live, the maximum size cap, the current on-disk size, and a manual
 * cleanup. Changing the folder does not migrate existing files (matches Ableton)
 * — old files stay until evicted or purged.
 */
function InterfaceZoomField() {
  const { t } = useTranslation();
  const zoom = useUiZoom();

  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">
        {t("transport.settingsModal.interfaceZoom", {
          defaultValue: "Interface size",
        })}
      </span>
      <select
        value={String(zoom)}
        onChange={(event) => setUiZoom(Number.parseFloat(event.target.value))}
      >
        {UI_ZOOM_STEPS.map((step) => (
          <option key={step} value={String(step)}>
            {`${Math.round(step * 100)}%`}
          </option>
        ))}
      </select>
      <small>
        {t("transport.settingsModal.interfaceZoomHelp", {
          defaultValue:
            "Scale the whole interface. Lower it if the app is wider than your screen. Shortcut: Cmd/Ctrl +, − and 0 to reset.",
        })}
      </small>
    </label>
  );
}

/** Exported for the mobile-contract test; rendered only from this panel. */
export function DecodingCacheField() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DecodingCacheInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxGbDraft, setMaxGbDraft] = useState("");

  const refresh = useCallback(async () => {
    const next = await getDecodingCacheInfo();
    setInfo(next);
    setMaxGbDraft(next.maxGb != null ? String(next.maxGb) : "");
  }, []);

  useEffect(() => {
    void refresh().catch((err) =>
      setError(formatUserFacingError(err, t)),
    );
  }, [refresh, t]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(formatUserFacingError(err, t));
      } finally {
        setBusy(false);
      }
    },
    [refresh, t],
  );

  const handleChangeFolder = () =>
    void run(async () => {
      const picked = await open({ multiple: false, directory: true });
      const path = typeof picked === "string" ? picked : null;
      if (!path) return;
      await setDecodingCacheDir(path);
    });

  const handleResetFolder = () => void run(() => setDecodingCacheDir(null));

  const handleApplyMaxGb = () =>
    void run(() => {
      const trimmed = maxGbDraft.trim();
      if (trimmed === "") return setDecodingCacheMaxGb(null);
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(
          t("transport.settingsModal.decodingCacheMaxInvalid", {
            defaultValue: "Enter a whole number of GB (1 or more), or leave empty for automatic.",
          }),
        );
      }
      return setDecodingCacheMaxGb(Math.floor(parsed));
    });

  // A purge that frees nothing because the files are open must not look like a
  // successful one. The engine streams audio straight out of the PCM cache, so
  // with a session loaded every file is held open and (on Windows) undeletable.
  const handlePurge = () =>
    void run(async () => {
      const result = await purgeDecodingCache();
      if (result.filesInUse > 0) {
        throw new Error(
          t("transport.settingsModal.decodingCacheInUse", {
            count: result.filesInUse,
            defaultValue:
              "{{count}} cache file(s) are in use by the open session and could not be deleted. Close the session (or the app) and clear the cache again.",
          }),
        );
      }
    });

  return (
    <div className="lt-settings-field">
      <span className="lt-settings-field-label">
        {t("transport.settingsModal.decodingCacheTitle", {
          defaultValue: "Audio cache",
        })}
      </span>
      <small>
        {isMobileApp
          ? t("transport.settingsModal.decodingCacheDescriptionMobile", {
              defaultValue:
                "Non-WAV audio (MP3, FLAC…) is decoded once and stored here so it loads instantly next time. The location is fixed to the app's own storage.",
            })
          : t("transport.settingsModal.decodingCacheDescription", {
              defaultValue:
                "Non-WAV audio (MP3, FLAC…) is decoded once and stored here so it loads instantly next time. Changing the folder leaves old files behind until you clear the cache.",
            })}
      </small>

      <div className="lt-cache-control-row">
        <input
          type="text"
          readOnly
          value={info?.dir ?? ""}
          title={info?.dir ?? ""}
          aria-label={t("transport.settingsModal.decodingCacheLocation", {
            defaultValue: "Cache location",
          })}
        />
        {/* No folder picking on a phone. Two reasons, either one enough:
            `tauri-plugin-dialog` returns FolderPickerNotImplemented for
            `directory: true` on mobile, so the button could only ever fail;
            and writing outside the app's own storage would need
            MANAGE_EXTERNAL_STORAGE, which Play grants to file managers and
            backup tools, not to a DAW (see AndroidManifest.xml). The size cap
            and Clear cache below are the parts that still mean something. */}
        {!isMobileApp ? (
          <>
            <button
              type="button"
              className="lt-secondary-button"
              disabled={busy}
              onClick={handleChangeFolder}
            >
              {t("transport.settingsModal.decodingCacheChange", {
                defaultValue: "Change…",
              })}
            </button>
            <button
              type="button"
              className="lt-secondary-button lt-cache-reset-button"
              disabled={busy}
              title={t("transport.settingsModal.decodingCacheResetHint", {
                defaultValue: "Use the default location",
              })}
              onClick={handleResetFolder}
            >
              {t("transport.settingsModal.decodingCacheReset", {
                defaultValue: "Default",
              })}
            </button>
          </>
        ) : null}
      </div>

      <div className="lt-cache-max-row">
        <span className="lt-cache-max-label">
          {t("transport.settingsModal.decodingCacheMaxLabel", {
            defaultValue: "Maximum size",
          })}
        </span>
        <span className="lt-cache-max-input">
          <input
            type="number"
            min={1}
            step={1}
            value={maxGbDraft}
            disabled={busy}
            placeholder={t("transport.settingsModal.decodingCacheMaxAuto", {
              defaultValue: "Auto",
            })}
            aria-label={t("transport.settingsModal.decodingCacheMaxLabel", {
              defaultValue: "Maximum size",
            })}
            onChange={(event) => setMaxGbDraft(event.target.value)}
          />
          <span className="lt-cache-max-unit" aria-hidden="true">
            GB
          </span>
        </span>
        <button
          type="button"
          className="lt-secondary-button"
          disabled={busy}
          onClick={handleApplyMaxGb}
        >
          {t("transport.settingsModal.decodingCacheApplyMax", {
            defaultValue: "Set limit",
          })}
        </button>
      </div>
      <small>
        {t("transport.settingsModal.decodingCacheMaxHelp", {
          defaultValue:
            "Leave empty for automatic (10% of free disk space, at least 4 GB).",
        })}
      </small>

      <div className="lt-inline-actions">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.decodingCacheCurrentSize", {
            defaultValue: "On disk: {{size}}",
            size: formatCacheBytes(info?.sizeBytes ?? 0),
          })}
        </span>
        <button
          type="button"
          className="lt-secondary-button"
          disabled={busy || (info?.sizeBytes ?? 0) === 0}
          onClick={handlePurge}
        >
          {t("transport.settingsModal.decodingCacheClear", {
            defaultValue: "Clear cache",
          })}
        </button>
      </div>

      {error ? (
        <small className="lt-update-check-status lt-update-check-status--error">
          {error}
        </small>
      ) : null}
    </div>
  );
}

