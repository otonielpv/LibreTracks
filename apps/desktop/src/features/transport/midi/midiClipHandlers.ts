import type { MidiClipSummary, MidiEventSummary, TransportSnapshot } from "../desktopApi";

/**
 * Handlers for creating, editing, moving and deleting MIDI clips.
 *
 * Lives in its own module rather than inside TransportPanelContent: per the
 * repo's rule, a new feature brings its own module and the monolith only calls
 * into it. Volatile state is read through getters so the factory can be built
 * once with `useMemo` and never has to be recreated.
 */
export type MidiClipHandlerDeps = {
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  translate: (key: string) => string;
  upsertMidiClip: (clip: MidiClipSummary) => Promise<TransportSnapshot>;
  deleteMidiClip: (clipId: string) => Promise<TransportSnapshot>;
  moveMidiClip: (
    clipId: string,
    timelineStartSeconds: number,
    targetTrackId: string | null,
  ) => Promise<TransportSnapshot>;
};

let clipCounter = 0;
function nextClipId() {
  clipCounter += 1;
  return `midi_clip_${Date.now()}_${clipCounter}`;
}

export function createMidiClipHandlers(deps: MidiClipHandlerDeps) {
  const {
    runAction,
    applyPlaybackSnapshot,
    setStatus,
    translate,
    upsertMidiClip,
    deleteMidiClip,
    moveMidiClip,
  } = deps;

  /**
   * Create or update a clip. A new clip is identified by a null `clipId`; the
   * id is minted here so the caller (the modal) never has to know about id
   * shape.
   */
  const handleSaveMidiClip = async (input: {
    clipId: string | null;
    trackId: string;
    timelineStartSeconds: number;
    name: string;
    events: MidiEventSummary[];
    color?: string | null;
  }) => {
    await runAction(async () => {
      const isNew = input.clipId === null;
      const snapshot = await upsertMidiClip({
        id: input.clipId ?? nextClipId(),
        trackId: input.trackId,
        timelineStartSeconds: input.timelineStartSeconds,
        name: input.name,
        events: input.events,
        color: input.color ?? null,
      });
      applyPlaybackSnapshot(snapshot);
      setStatus(
        translate(
          isNew ? "transport.midi.statusClipAdded" : "transport.midi.statusClipUpdated",
        ),
      );
    });
  };

  const handleDeleteMidiClip = async (clipId: string) => {
    await runAction(async () => {
      const snapshot = await deleteMidiClip(clipId);
      applyPlaybackSnapshot(snapshot);
      setStatus(translate("transport.midi.statusClipDeleted"));
    });
  };

  const handleMoveMidiClip = async (
    clipId: string,
    timelineStartSeconds: number,
    targetTrackId: string | null = null,
  ) => {
    await runAction(async () => {
      const snapshot = await moveMidiClip(
        clipId,
        timelineStartSeconds,
        targetTrackId,
      );
      applyPlaybackSnapshot(snapshot);
      setStatus(translate("transport.midi.statusClipMoved"));
    });
  };

  return {
    handleSaveMidiClip,
    handleDeleteMidiClip,
    handleMoveMidiClip,
  };
}
