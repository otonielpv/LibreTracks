import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";

import { useMidiClipHotspots } from "./useMidiClipHotspots";
import type { MidiClipSummary, SongView } from "../desktopApi";

export type MidiLaneCallbacks = {
  onEdit?: (clip: MidiClipSummary) => void;
  onContextMenu?: (
    event: ReactMouseEvent<HTMLElement>,
    clip: MidiClipSummary,
  ) => void;
  onMoveClip?: (clipId: string, timelineStartSeconds: number) => void;
};

/**
 * Everything the timeline needs to render the MIDI lanes: the drag state and
 * the props its overlay components take.
 *
 * The drag lives here (rather than inside MidiClipHotspots) because the drop
 * guide is painted OUTSIDE the lane — over the whole track area — and so needs
 * to see the in-flight position too.
 */
export function useMidiLane({
  song,
  camera,
  snapEnabled,
  callbacks,
}: {
  song: SongView | null;
  camera: {
    cameraXRef: MutableRefObject<number>;
    livePixelsPerSecondRef: MutableRefObject<number>;
    pixelsPerSecond: number;
  };
  snapEnabled?: boolean;
  callbacks?: MidiLaneCallbacks;
}) {
  const hotspots = useMidiClipHotspots({
    clips: song?.midiClips,
    ...camera,
    song,
    snapEnabled,
    onMoveClip: (id, seconds) => callbacks?.onMoveClip?.(id, seconds),
  });

  return {
    /** Props for <MidiDropGuide>, bound to the caller's x resolver. */
    guide: (resolveLeft: (seconds: number) => number) => ({
      guideSeconds: hotspots.guideSeconds,
      resolveLeft,
    }),
    /** Full prop set for <MidiClipHotspots> on one lane. */
    lane: (trackId: string, trackHeight: number) => ({
      trackId,
      trackHeight,
      song,
      camera,
      hotspots,
      onEdit: callbacks?.onEdit,
      onContextMenu: callbacks?.onContextMenu,
    }),
  };
}
