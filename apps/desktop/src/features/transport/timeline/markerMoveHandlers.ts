import type {
  AutomationCueSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";

/**
 * Dependencies for the ruler drag-commit handlers extracted from
 * TransportPanelContent. TimelineCanvasPane owns the optimistic preview during
 * the drag and calls these only once, on release, with the final snapped
 * position — so these handlers are plain "persist the new position" calls.
 *
 * `getSong` is a getter rather than a value so the factory can be memoised
 * once: the song changes on every snapshot, and recreating the handlers each
 * time would defeat the referential stability the timeline relies on.
 */
export type MarkerMoveHandlerDeps = {
  getSong: () => SongView | null;
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSongView: (options?: {
    sync?: boolean;
    includeWaveforms?: boolean;
  }) => Promise<SongView | null>;
  updateSectionMarker: (
    markerId: string,
    name: string,
    startSeconds: number,
  ) => Promise<TransportSnapshot>;
  upsertAutomationCue: (
    cue: AutomationCueSummary,
  ) => Promise<TransportSnapshot>;
  /** Getter: the menu factory rebuilds this callback on every render. */
  getEditAutomationCue: () => (cue: AutomationCueSummary) => void;
};

export function createMarkerMoveHandlers(deps: MarkerMoveHandlerDeps) {
  const {
    getSong,
    runAction,
    applyPlaybackSnapshot,
    refreshSongView,
    updateSectionMarker,
    upsertAutomationCue,
    getEditAutomationCue,
  } = deps;

  /** Persist a section/cue flag dragged along the ruler to its new position. */
  const handleMarkerMoveCommit = (markerId: string, startSeconds: number) => {
    const section = getSong()?.sectionMarkers.find(
      (candidate) => candidate.id === markerId,
    );
    if (!section) {
      return;
    }
    void runAction(async () => {
      const nextSnapshot = await updateSectionMarker(
        section.id,
        section.name,
        startSeconds,
      );
      applyPlaybackSnapshot(nextSnapshot);
    });
  };

  /** Persist an automation-cue diamond dragged along its lane. */
  const handleAutomationCueMoveCommit = (cueId: string, atSeconds: number) => {
    const cue = getSong()?.automationCues?.find(
      (candidate) => candidate.id === cueId,
    );
    if (!cue) {
      return;
    }
    // Re-upsert the whole cue with only its position changed, so
    // name/enabled/maxRuns/actions survive the move.
    void runAction(async () => {
      const nextSnapshot = await upsertAutomationCue({ ...cue, atSeconds });
      applyPlaybackSnapshot(nextSnapshot);
      await refreshSongView({ includeWaveforms: false, sync: true });
    });
  };

  /** Open the cue editor for the diamond that was left-clicked. */
  const handleAutomationCueEdit = (cueId: string) => {
    const cue = getSong()?.automationCues?.find(
      (candidate) => candidate.id === cueId,
    );
    if (cue) {
      getEditAutomationCue()(cue);
    }
  };

  return {
    handleMarkerMoveCommit,
    handleAutomationCueMoveCommit,
    handleAutomationCueEdit,
  };
}
