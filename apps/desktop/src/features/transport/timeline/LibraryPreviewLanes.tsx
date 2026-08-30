import type { DragEvent as ReactDragEvent } from "react";

import type { LibraryClipPreviewState } from "../types";

/** A row of ghost clips for audio being dragged in from the library, shown
 * below the real lanes for the tracks the drop would create. */
export type LibraryPreviewRow = {
  rowOffset: number;
  title: string;
  previews: LibraryClipPreviewState[];
};

type LibraryPreviewLanesProps = {
  rows: LibraryPreviewRow[];
  /** These lanes belong to tracks that do not exist yet, so they always take
   * the global height — there is nothing to carry a per-track offset. */
  trackHeight: number;
  pixelsPerSecond: number;
  resolveLibraryGhostLeft: (seconds: number) => number;
  onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => void;
};

export function LibraryPreviewLanes({
  rows,
  trackHeight,
  pixelsPerSecond,
  resolveLibraryGhostLeft,
  onDragEnter,
}: LibraryPreviewLanesProps) {
  return (
    <>
      {rows.map((previewRow) => (
        <div
          key={`library-preview-lane-${previewRow.rowOffset}`}
          className="lt-track-lane-row is-library-preview"
          style={{ height: trackHeight }}
        >
          <div
            className="lt-track-lane is-library-preview"
            style={{ height: trackHeight }}
            aria-label={`Preview lane ${previewRow.title}`}
            onDragEnter={onDragEnter}
          >
            {previewRow.previews.map((preview) => (
              <div
                key={`${preview.filePath}-${preview.rowOffset}-${preview.timelineStartSeconds}`}
                className="lt-library-clip-ghost"
                style={{
                  left: resolveLibraryGhostLeft(preview.timelineStartSeconds),
                  width: Math.max(preview.durationSeconds * pixelsPerSecond, 36),
                }}
              >
                <span>{preview.label}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
