/**
 * Dependencies for the MIDI-learn arming handlers extracted from
 * TransportPanelContent. `midiLearnMode` lives in the timeline UI store and is
 * read through a getter so the factory stays referentially stable; `setMidiLearnMode`
 * is the store setter. An empty-string mode means "armed, no target yet"; null
 * means learn mode is off.
 */
export type MidiLearnHandlerDeps = {
  getMidiLearnMode: () => string | null;
  setMidiLearnMode: (mode: string | null) => void;
  setIsSettingsModalOpen: (open: boolean) => void;
  setIsRemoteModalOpen: (open: boolean) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  prompt: (message: string) => Promise<string | null>;
};

export function createMidiLearnHandlers(deps: MidiLearnHandlerDeps) {
  const {
    getMidiLearnMode,
    setMidiLearnMode,
    setIsSettingsModalOpen,
    setIsRemoteModalOpen,
    t,
    prompt,
  } = deps;

  const handleMidiLearnTarget = (
    controlKey: string,
    options?: { arm?: boolean },
  ) => {
    // Without `arm`, ignore targeting while learn mode is off — this lets the
    // same handler drive both "click a control while armed" and "arm directly".
    if (getMidiLearnMode() === null && !options?.arm) {
      return false;
    }
    setMidiLearnMode(controlKey);
    return true;
  };

  return {
    handleMidiLearnToggle(options?: { closePanels?: boolean }) {
      if (options?.closePanels) {
        setIsSettingsModalOpen(false);
        setIsRemoteModalOpen(false);
      }
      setMidiLearnMode(getMidiLearnMode() === null ? "" : null);
    },

    handleMidiLearnTarget,

    handleMidiLearnCommandRelearn(controlKey: string) {
      setMidiLearnMode(controlKey);
    },

    async handleDynamicMidiLearnJump(kind: "marker" | "song") {
      const maxIndex = kind === "marker" ? 100 : 20;
      const rawValue = await prompt(
        kind === "marker"
          ? t("transport.settingsModal.midiLearnMapMarkerPrompt")
          : t("transport.settingsModal.midiLearnMapSongPrompt"),
      );
      if (rawValue === null) {
        return;
      }

      const index = Number(rawValue.trim());
      if (!Number.isInteger(index) || index < 1 || index > maxIndex) {
        return;
      }

      handleMidiLearnTarget(
        kind === "marker"
          ? `action:jump_marker_${index}`
          : `action:jump_song_${index}`,
        { arm: true },
      );
    },
  };
}

export type MidiLearnHandlers = ReturnType<typeof createMidiLearnHandlers>;
