import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type SongView,
} from "@libretracks/shared/models";

import "../../../shared/i18n";
import { useMidiRawMessages } from "../hooks/useMidiRawMessages";
import { setSong } from "../songStore";
import { useTimelineUIStore } from "../uiStore";
import { MidiLearnSettingsTab } from "./MidiLearnSettingsTab";

/**
 * The "Scenes" view of MIDI Learn (plan live-scenes): one row per target of
 * each scene of the session, learnt from Settings in any view, end to end
 * through the real raw-message listener.
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

function Harness({ layout }: { layout: "list" | "table" }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
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
    formatMidiLearnCommandLabel: (key) => key,
    t: (key) => key,
    onSelectRegionRef: { current: null },
    onRegionTransposeRef: { current: null },
  });

  return (
    <MidiLearnSettingsTab
      layout={layout}
      isLoading={false}
      isSaving={false}
      hasMappings={Object.keys(settings.midiMappings).length > 0}
      midiLearnMode={midiLearnMode}
      midiLearnFeedback={null}
      midiLearnFeedbackCommand={null}
      midiLearnView="scenes"
      onMidiLearnViewChange={() => {}}
      midiLearnMarkerRows={[]}
      midiLearnSongRows={[]}
      visibleMidiLearnRows={[]}
      activeMidiLearnCommand={null}
      onMidiLearnToggle={() => {}}
      onResetMidiMappings={() => {}}
      onMidiLearnCommandRelearn={(key) => setMidiLearnMode(key)}
      onDynamicMidiLearnJump={() => {}}
      midiMappings={settings.midiMappings}
      onMidiBindingChange={() => {}}
      formatCommandLabel={(key) => key}
      selectedMidiInput={null}
      onApplyControllerProfile={() => {}}
    />
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const withScene = {
  tracks: [],
  mixScenes: [{ id: "s1", name: "Ministrar", rampSeconds: 2, rules: [] }],
} as unknown as SongView;

describe("MidiLearnSettingsTab, Scenes view", () => {
  beforeEach(() => {
    api.rawHandler = null;
    api.saved = [];
    useTimelineUIStore.getState().setMidiLearnMode(null);
  });

  afterEach(() => {
    cleanup();
    setSong(null);
  });

  it("lists toggle, engage and release per scene, then slots 1-8", async () => {
    setSong(withScene);
    render(<Harness layout="list" />);
    await flush();
    expect(screen.getAllByRole("listitem")).toHaveLength(3 + 8);
    expect(screen.getByText("Scene “Ministrar” (toggle)")).toBeTruthy();
    expect(screen.getByText("Scene “Ministrar” (engage)")).toBeTruthy();
    expect(screen.getByText("Scene “Ministrar” (release)")).toBeTruthy();
    expect(screen.getByText("Scene 8 (toggle)")).toBeTruthy();
    expect(screen.queryByText(/This session has no scenes/)).toBeNull();
  });

  it("Learn on a scene row + a MIDI message saves that scene's binding", async () => {
    setSong(withScene);
    render(<Harness layout="list" />);
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Learn: Scene “Ministrar” (engage)" }),
    );
    await act(async () => {
      api.rawHandler?.({ status: 0x90, data1: 36, data2: 100 });
    });
    await flush();
    const saved = api.saved.at(-1);
    expect(saved?.midiMappings["scene:s1:apply"]).toMatchObject({ status: 0x90, data1: 36 });
  });

  it("without scenes it says where to make them and keeps the slots", async () => {
    setSong({ tracks: [], mixScenes: [] } as unknown as SongView);
    render(<Harness layout="table" />);
    await flush();
    expect(screen.getByText(/This session has no scenes/)).toBeTruthy();
    expect(screen.getByText("Scene 1 (toggle)")).toBeTruthy();
  });
});
