import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from "@libretracks/shared/models";

import "../../../shared/i18n";
import { useMidiRawMessages } from "../hooks/useMidiRawMessages";
import { useTimelineUIStore } from "../uiStore";
import { MidiLearnSettingsTab } from "./MidiLearnSettingsTab";

/**
 * MIDI Learn on a phone (plan mobile-midi, paso 05): the list layout, driven
 * end to end through the real raw-message listener. Tap "Learn" on a row,
 * a `midi:raw_message` arrives, the binding is saved and shows up as a chip.
 */

type RawMessage = { status: number; data1: number; data2: number };

const api = vi.hoisted(() => ({
  rawHandler: null as ((message: RawMessage) => void) | null,
  saved: [] as AppSettings[],
}));

vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...actual,
    isTauriApp: true,
    listenToMidiRawMessage: vi.fn(async (handler: (message: RawMessage) => void) => {
      api.rawHandler = handler;
      return () => {
        api.rawHandler = null;
      };
    }),
    updateAudioSettings: vi.fn(async (settings: AppSettings) => settings),
    saveSettings: vi.fn(async (settings: AppSettings) => {
      api.saved.push(settings);
      return settings;
    }),
  };
});

const LABELS: Record<string, string> = {
  "action:play": "Play",
  "action:stop": "Stop",
};

/** The pieces TransportPanelContent wires together, minus the panel. */
function Harness() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const settingsRef = useRef(settings);
  const midiLearnMode = useTimelineUIStore((state) => state.midiLearnMode);
  const setMidiLearnMode = useTimelineUIStore((state) => state.setMidiLearnMode);

  useMidiRawMessages({
    appSettingsRef: settingsRef,
    setAppSettings: setSettings,
    setMidiLearnMode,
    setMidiLearnFeedback: () => {},
    setStatus: () => {},
    runAction: async (action) => {
      await action();
    },
    formatMidiLearnCommandLabel: (key) => LABELS[key] ?? key,
    t: (key) => key,
    onSelectRegionRef: { current: null },
    onRegionTransposeRef: { current: null },
  });

  const rows = Object.keys(LABELS).map((key) => ({
    key,
    label: LABELS[key],
    binding: settings.midiMappings[key] ?? null,
  }));

  return (
    <MidiLearnSettingsTab
      layout="list"
      isLoading={false}
      isSaving={false}
      hasMappings={Object.keys(settings.midiMappings).length > 0}
      midiLearnMode={midiLearnMode}
      midiLearnFeedback={null}
      midiLearnFeedbackCommand={null}
      midiLearnView="core"
      onMidiLearnViewChange={() => {}}
      midiLearnMarkerRows={[]}
      midiLearnSongRows={[]}
      visibleMidiLearnRows={rows}
      activeMidiLearnCommand={null}
      onMidiLearnToggle={() => {}}
      onResetMidiMappings={() => {}}
      // What createMidiLearnHandlers.handleMidiLearnCommandRelearn does.
      onMidiLearnCommandRelearn={(key) => setMidiLearnMode(key)}
      onDynamicMidiLearnJump={() => {}}
    />
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MidiLearnSettingsTab on a phone", () => {
  beforeEach(() => {
    api.rawHandler = null;
    api.saved = [];
    useTimelineUIStore.getState().setMidiLearnMode(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a list of rows, not the desktop table", async () => {
    render(<Harness />);
    await flush();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("Learn + a raw MIDI message saves the binding and shows it as a chip", async () => {
    render(<Harness />);
    await flush();

    const playRow = screen.getAllByRole("listitem")[0];
    expect(within(playRow).getByText("Unassigned")).toBeTruthy();
    fireEvent.click(within(playRow).getByRole("button", { name: "Learn: Play" }));
    expect(useTimelineUIStore.getState().midiLearnMode).toBe("action:play");
    expect(within(playRow).getByText("Listening")).toBeTruthy();

    // A foot pedal sends note 60.
    await act(async () => {
      api.rawHandler?.({ status: 0x90, data1: 60, data2: 100 });
    });
    await flush();

    expect(api.saved).toHaveLength(1);
    expect(api.saved[0].midiMappings["action:play"]).toEqual({
      status: 0x90,
      data1: 60,
      isCc: false,
    });
    expect(useTimelineUIStore.getState().midiLearnMode).toBeNull();
    const updatedRow = screen.getAllByRole("listitem")[0];
    expect(within(updatedRow).queryByText("Unassigned")).toBeNull();
    expect(
      within(updatedRow).getByRole("button", { name: "Relearn: Play" }),
    ).toBeTruthy();
  });
});
