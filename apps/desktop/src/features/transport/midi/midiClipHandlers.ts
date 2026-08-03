import {
  deleteMidiClip,
  moveMidiClip,
  setAutomationTrackEnabled,
  setMidiTrackEnabled,
  setMidiTrackRouting,
  upsertMidiClip,
  type MidiEventSummary,
  type TrackSummary,
  type TransportSnapshot,
} from "../desktopApi";
import type { MidiRouteDraft } from "../panels/MidiRouteModal";

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
  refreshSongView: (options?: {
    sync?: boolean;
    includeWaveforms?: boolean;
  }) => Promise<unknown>;
  /** Reads the live song, so the factory never closes over a stale track. */
  getTrack: (trackId: string) => TrackSummary | null;
  setMidiRouteDraft: (draft: MidiRouteDraft | null) => void;
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
    refreshSongView,
    getTrack,
    setMidiRouteDraft,
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

  /**
   * Point a MIDI track at a port and channel. The song view is refreshed
   * because the header badge reads these straight off the track — leaving it
   * to the next snapshot would show stale routing for a moment.
   */
  const handleSetMidiRoute = async (
    trackId: string,
    port: string | null,
    channel: number,
  ) => {
    await runAction(async () => {
      const snapshot = await setMidiTrackRouting(trackId, port, channel);
      applyPlaybackSnapshot(snapshot);
      await refreshSongView({ includeWaveforms: false, sync: true });
      setStatus(translate("transport.midi.statusRouteUpdated"));
    });
  };

  /** Seed the routing dialog from the track's current port and channel. */
  const openMidiRouteEditor = (trackId: string) => {
    const track = getTrack(trackId);
    if (!track) return;
    setMidiRouteDraft({
      trackId,
      trackName: track.name,
      port: track.midiPort ?? null,
      channel: track.midiChannel ?? 1,
    });
  };

  /** MIDI's answer to mute: the track either sends or it doesn't. */
  const handleToggleMidiEnabled = async (trackId: string) => {
    const track = getTrack(trackId);
    if (!track) return;
    const next = track.midiEnabled === false;
    await runAction(async () => {
      const snapshot = await setMidiTrackEnabled(trackId, next);
      applyPlaybackSnapshot(snapshot);
      await refreshSongView({ includeWaveforms: false, sync: true });
      setStatus(
        translate(
          next
            ? "transport.midi.statusTrackEnabled"
            : "transport.midi.statusTrackDisabled",
        ),
      );
    });
  };

  /** Same switch for the automation lane; its cues stay authored either way. */
  const handleToggleAutomationEnabled = async (enabled: boolean) => {
    await runAction(async () => {
      const snapshot = await setAutomationTrackEnabled(enabled);
      applyPlaybackSnapshot(snapshot);
      await refreshSongView({ includeWaveforms: false, sync: true });
      setStatus(
        translate(
          enabled
            ? "transport.automation.statusTrackEnabled"
            : "transport.automation.statusTrackDisabled",
        ),
      );
    });
  };

  /** The lane controls the track headers need, bundled as one prop. */
  const laneControls = (automationEnabled?: boolean) => ({
    onEditRoute: openMidiRouteEditor,
    onToggleMidiEnabled: handleToggleMidiEnabled,
    onToggleAutomationEnabled: handleToggleAutomationEnabled,
    automationEnabled,
  });

  // Fire-and-forget wrappers for the modals, which are not async-aware.
  const saveClip = (result: Parameters<typeof handleSaveMidiClip>[0]) => {
    void handleSaveMidiClip(result);
  };
  const saveRoute = (trackId: string, port: string | null, channel: number) => {
    void handleSetMidiRoute(trackId, port, channel);
  };

  const moveClip = (clipId: string, timelineStartSeconds: number) => {
    void handleMoveMidiClip(clipId, timelineStartSeconds);
  };

  return {
    moveClip,
    saveClip,
    saveRoute,
    laneControls,
    openMidiRouteEditor,
    handleToggleMidiEnabled,
    handleToggleAutomationEnabled,
    handleSaveMidiClip,
    handleDeleteMidiClip,
    handleMoveMidiClip,
    handleSetMidiRoute,
  };
}
