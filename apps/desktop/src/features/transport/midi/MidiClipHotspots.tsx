import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";

import { secondsToScreenX } from "../timeline/timelineMath";
import type { MidiClipSummary, SongView } from "../desktopApi";
import { useMidiClipHotspots } from "./useMidiClipHotspots";

/**
 * The invisible hit targets for a MIDI track's clips.
 *
 * The canvas paints the markers; these buttons sit on top and carry the drag,
 * the click that opens the editor and the right-click menu — the same split the
 * automation lane uses. `left` is owned by the rAF loop in
 * `useMidiClipHotspots` (it must track cameraX/live zoom exactly the way the
 * canvas paints), and is seeded here so the button is placed on its first frame.
 */
export type MidiClipHotspotsProps = {
  /** The lane's track; its clips are selected out of `song` here. */
  trackId: string;
  song: SongView | null;
  trackHeight: number;
  /** Live camera/zoom, grouped: all three always travel together. */
  camera: {
    cameraXRef: MutableRefObject<number>;
    livePixelsPerSecondRef: MutableRefObject<number>;
    pixelsPerSecond: number;
  };
  /** Shared screen↔time helper; camera and zoom are bound here. */
  screenXToSeconds: (
    screenX: number,
    cameraX: number,
    pixelsPerSecond: number,
  ) => number;
  /** Commit a dragged clip to its new position. */
  onMoveClip?: (clipId: string, timelineStartSeconds: number) => void;
  onEdit?: (clip: MidiClipSummary) => void;
  onContextMenu?: (
    event: ReactMouseEvent<HTMLElement>,
    clip: MidiClipSummary,
  ) => void;
};

export function MidiClipHotspots({
  trackId,
  song,
  trackHeight,
  camera,
  screenXToSeconds,
  onMoveClip,
  onEdit,
  onContextMenu,
}: MidiClipHotspotsProps) {
  const clips = (song?.midiClips ?? []).filter(
    (clip) => clip.trackId === trackId,
  );
  const { cameraXRef, livePixelsPerSecondRef, pixelsPerSecond } = camera;
  const {
    registerHotspot,
    onBeginMove,
    onUpdateMove,
    onEndMove,
    consumeDragClick,
    preview,
  } = useMidiClipHotspots({
    clips,
    cameraXRef,
    livePixelsPerSecondRef,
    pixelsPerSecond,
    screenXToSeconds: (screenX: number) =>
      screenXToSeconds(
        screenX,
        cameraXRef.current,
        livePixelsPerSecondRef.current ?? pixelsPerSecond,
      ),
    onMoveClip: (clipId, seconds) => onMoveClip?.(clipId, seconds),
  });
  const cameraX = cameraXRef.current;
  const livePixelsPerSecond = livePixelsPerSecondRef.current ?? pixelsPerSecond;

  return (
    <>
      {clips.map((clip) => {
        const isDragging = preview?.clipId === clip.id;
        const renderAtSeconds = isDragging
          ? preview.startSeconds
          : clip.timelineStartSeconds;
        const label = clip.name || "MIDI";

        return (
          <button
            key={clip.id}
            ref={(element) => registerHotspot(clip.id, element)}
            type="button"
            className={`lt-automation-hotspot${isDragging ? " is-dragging" : ""}`}
            aria-label={label}
            title={label}
            style={{
              left: secondsToScreenX(
                renderAtSeconds,
                cameraX,
                livePixelsPerSecond,
              ),
              top: trackHeight / 2,
            }}
            onMouseDown={(event) => {
              // Left button only: preventDefault on the right one would cancel
              // the contextmenu event and break right-click.
              if (event.button === 0) {
                event.preventDefault();
              }
              event.stopPropagation();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              onBeginMove(event, clip);
            }}
            onPointerMove={onUpdateMove}
            onPointerUp={onEndMove}
            onPointerCancel={onEndMove}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (consumeDragClick()) return;
              onEdit?.(clip);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu?.(event, clip);
            }}
          />
        );
      })}
    </>
  );
}
