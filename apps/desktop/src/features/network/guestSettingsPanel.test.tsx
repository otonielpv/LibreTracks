import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGuestMirrorMode } from "@libretracks/shared/desktopApi";
import { DEFAULT_APP_SETTINGS } from "@libretracks/shared/models";
import type { NetworkRole } from "@libretracks/shared/networkRoles";
import { SettingsPanel } from "../transport/panels/SettingsPanel";
import { EMPTY_GUEST_STATUS, useNetworkSessionStore } from "./networkSessionStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type Props = ComponentProps<typeof SettingsPanel>;

function settingsProps(activeTab: Props["activeTab"] = "general"): Props {
  const noop = vi.fn();
  return {
    isOpen: true, onClose: noop, activeTab, onTabChange: noop,
    settingsTabs: [
      { id: "general", label: "General" }, { id: "audio", label: "Audio" },
      { id: "midi", label: "MIDI" }, { id: "midiLearn", label: "MIDI Learn" },
      { id: "video", label: "Video" },
    ],
    isLoading: false, isSaving: false, appSettings: DEFAULT_APP_SETTINGS,
    audioBackendOptions: [], audioDevicesForSelectedBackend: [],
    defaultAudioOutputDevice: null, selectedAudioOutputDevice: "",
    selectedAudioOutputDeviceMissing: false, selectedOutputChannelCount: 2,
    outputSampleRateOptions: [], autoOutputSampleRateLabel: "Auto",
    outputBufferSizes: [], audioRoutingOptions: [],
    onAudioBackendChange: noop, onAudioOutputDeviceChange: noop,
    onRefreshAudioDevices: noop, isAudioRefreshing: false,
    onOutputSampleRateChange: noop, onOutputBufferSizeChange: noop,
    onEnabledOutputChannelChange: noop, enabledOutputChannelsDraft: [],
    enabledOutputChannelsDirty: false, onCommitEnabledOutputChannels: noop,
    onDiscardEnabledOutputChannels: noop, onSelectAllOutputChannels: noop,
    onClearOutputChannels: noop, onLowLatencyOutputChange: noop,
    onAudioSingleThreadRenderChange: noop, onTrackMeterModeChange: noop,
    midiInputDevices: [], isMidiInputRefreshing: false,
    selectedMidiInputDevice: "", selectedMidiInputDeviceMissing: false,
    onMidiInputDeviceChange: noop, onRefreshMidiInputDevices: noop,
    midiOutput: {
      devices: [], selected: "", selectedMissing: false, onChange: noop,
      onRefresh: noop, onSendTestNote: noop,
      platform: {
        controllerOutput: null, networkSession: false, virtualPort: false, keepInBackground: true,
        onChange: noop,
      },
    },
    selectedLocale: "es", onLocaleChange: vi.fn(),
    onTimelineNavigationSchemeChange: noop, onTimelinePlayheadFollowModeChange: noop,
    onPauseAtSongEndChange: vi.fn(), onVampBetweenSongsChange: noop,
    onFadeOutStopSecondsChange: noop, onSongTrackLayoutChange: noop,
    onDefaultSongTemplateChange: noop, onReferenceImportedAudioChange: noop,
    onAutoColorNewTracksChange: noop, onAutoWarpChange: noop, onAutoSaveEnabledChange: noop,
    onAutoSaveIntervalMinutesChange: noop, midiLearnMode: null,
    midiLearnFeedback: null, midiLearnFeedbackCommand: null, midiLearnView: "core",
    onMidiLearnViewChange: noop, midiLearnMarkerRows: [], midiLearnSongRows: [],
    visibleMidiLearnRows: [], activeMidiLearnCommand: null, onMidiLearnToggle: noop,
    onResetMidiMappings: noop, onMidiLearnCommandRelearn: noop,
    onDynamicMidiLearnJump: noop, onMidiLearnTarget: noop,
    onMidiBindingChange: noop, formatMidiLearnCommandLabel: (key: string) => key,
  };
}

function setRole(role: NetworkRole) {
  useNetworkSessionStore.getState().setGuest({
    ...EMPTY_GUEST_STATUS, joined: true, state: "connected", role,
  });
}

beforeEach(() => setGuestMirrorMode(true));
afterEach(() => {
  cleanup();
  setGuestMirrorMode(false);
  useNetworkSessionStore.getState().setGuest(EMPTY_GUEST_STATUS);
});

describe("guest settings panel", () => {
  it("keeps viewer preferences available but hides hardware and disables playback changes", () => {
    setRole("viewer");
    const props = settingsProps("video");
    render(<SettingsPanel {...props} />);
    expect(screen.queryByRole("tab", { name: /MIDI|Video/ })).toBeNull();
    const language = screen.getByRole("combobox", { name: "transport.settingsModal.language" });
    expect(language.matches(":disabled")).toBe(false);
    fireEvent.change(language, { target: { value: "en" } });
    expect(props.onLocaleChange).toHaveBeenCalledWith("en");
    for (const field of ["timelineNavigationScheme", "timelinePlayheadFollowMode"]) {
      expect(screen.getByRole("combobox", { name: new RegExp(`transport.settingsModal.${field}`) }).matches(":disabled")).toBe(false);
    }
    const pause = screen.getByRole("checkbox", { name: /transport.settingsModal.pauseAtSongEnd/ });
    expect(pause.matches(":disabled")).toBe(true);
    pause.click();
    expect(props.onPauseAtSongEndChange).not.toHaveBeenCalled();
    expect(screen.getByRole("spinbutton", { name: /transport.settingsModal.fadeOutStopSeconds/ }).matches(":disabled")).toBe(true);
    expect(screen.queryByText("transport.settingsModal.autoSaveEnabled")).toBeNull();
    expect(screen.queryByText("transport.settingsModal.songTrackLayout")).toBeNull();
  });

  it("enables controller playback settings and revokes them live", () => {
    setRole("controller");
    const props = settingsProps();
    render(<SettingsPanel {...props} />);
    const pause = screen.getByRole("checkbox", { name: /transport.settingsModal.pauseAtSongEnd/ });
    expect(pause.matches(":disabled")).toBe(false);
    fireEvent.click(pause);
    expect(props.onPauseAtSongEndChange).toHaveBeenCalled();
    act(() => setRole("viewer"));
    expect(pause.matches(":disabled")).toBe(true);
  });

  it.each(["viewer", "controller", "editor"] as const)("%s: exposes only the permitted host metering option in Audio", (role) => {
    setRole(role);
    render(<SettingsPanel {...settingsProps("audio")} />);
    const meter = screen.getByRole("combobox", { name: /transport.settingsModal.trackMeterMode/ });
    expect(meter.matches(":disabled")).toBe(role !== "editor");
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
  });
});
