import type {
  AutomationCueSummary,
  MarkerCategory,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";
import { duplicateRulerMarkers } from "../desktopApi";

/** Same shape as `createAutomationCueId` (timelineMenus imports this module's
 * users, so it is not imported from there). */
function nextCueId() {
  return `automation_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

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
  }) => Promise<SongView | null>;
  updateSectionMarker: (
    markerId: string,
    name: string,
    startSeconds: number,
    categoryOverride?: MarkerCategory,
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

  /**
   * Persist a section/cue flag dragged along the ruler to its new position.
   *
   * `category` is passed only when the drag also crossed into the other lane,
   * which changes how the marker is announced (count-in vs one-shot); a plain
   * horizontal move leaves it undefined so the backend keeps what it had.
   */
  const handleMarkerMoveCommit = (
    markerId: string,
    startSeconds: number,
    category?: MarkerCategory,
    copy = false,
  ) => {
    const section = getSong()?.sectionMarkers.find(
      (candidate) => candidate.id === markerId,
    );
    if (!section) {
      return;
    }
    if (copy) {
      // Alt/Option at the drop: a copy lands there (in the lane it was
      // dropped in), the original stays.
      void runAction(async () => {
        applyPlaybackSnapshot(
          await duplicateRulerMarkers([
            {
              kind: "section",
              id: section.id,
              startSeconds,
              ...(category ? { categoryOverride: category } : {}),
            },
          ]),
        );
        await refreshSongView({ sync: true });
      });
      return;
    }
    void runAction(async () => {
      const nextSnapshot = await updateSectionMarker(
        section.id,
        section.name,
        startSeconds,
        category,
      );
      applyPlaybackSnapshot(nextSnapshot);
      // A lane change alters what the voice guide does with this marker, so the
      // view has to be re-read for the flag to settle in its new row.
      if (category) {
        await refreshSongView({ sync: true });
      }
    });
  };

  /** Persist an automation-cue diamond dragged along its lane. */
  const handleAutomationCueMoveCommit = (cueId: string, atSeconds: number, copy = false) => {
    const cue = getSong()?.automationCues?.find(
      (candidate) => candidate.id === cueId,
    );
    if (!cue) {
      return;
    }
    // Re-upsert the whole cue with only its position changed, so
    // name/enabled/maxRuns/actions survive the move. Alt/Option at the drop
    // writes a copy there under a new id instead.
    void runAction(async () => {
      const nextSnapshot = await upsertAutomationCue(
        copy ? { ...cue, id: nextCueId(), atSeconds } : { ...cue, atSeconds },
      );
      applyPlaybackSnapshot(nextSnapshot);
      await refreshSongView({ sync: true });
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
