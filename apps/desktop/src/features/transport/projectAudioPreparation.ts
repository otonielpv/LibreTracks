import type { ProjectLoadProgressEvent } from "@libretracks/shared/models";
import type { SourcesPrepareUiState } from "./sourcesPrepare";

export function projectAudioPreparationStateFromEvent(
  event: ProjectLoadProgressEvent,
): SourcesPrepareUiState {
  return {
    active: event.percent < 100,
    percent: Math.max(0, Math.min(100, event.percent)),
    readyCount: event.sourcesReady,
    total: event.sourcesTotal,
    failedCount: 0,
  };
}
