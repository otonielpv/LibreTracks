import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import type {
  ClipSummary,
  SongRegionSummary,
  SongView,
  TrackSummary,
  WaveformSummaryDto,
} from "@libretracks/shared/models";

import type { SetlistLayoutClass } from "../useSetlistLayout";
import type { SongTimeScale } from "../songTimeScale";
import type { ClipGestureMode } from "./useClipGestures";

/** What every lane of the song gets: the one time scale of the view, the
 * song's data and the container's gesture and menu entry points. */
export type SongLaneRenderProps = {
  track: TrackSummary;
  song: SongView;
  region: SongRegionSummary;
  scale: SongTimeScale;
  layout: SetlistLayoutClass;
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  editable: boolean;
  onClipPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    clip: ClipSummary,
    mode: ClipGestureMode,
  ) => void;
  onClipContextMenu: (event: ReactMouseEvent<HTMLElement>, clip: ClipSummary) => void;
};

/**
 * A kind of lane (audio here; automation, MIDI, video and tempo in steps
 * 12-15). The container only knows this interface, so each step adds a file
 * without touching it.
 */
export type SongLaneType = {
  kind: string;
  /** Row height in px. */
  rowHeight: number;
  /** Whether this lane draws `track`. The first type that accepts wins. */
  accepts: (track: TrackSummary) => boolean;
  render: (props: SongLaneRenderProps) => ReactNode;
};
