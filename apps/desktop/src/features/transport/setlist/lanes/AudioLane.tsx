import { memo, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import type { ClipSummary } from "@libretracks/shared/models";

import { useTimelineUIStore } from "../../uiStore";
import { buildSongOverviewPeaks } from "../songOverviewPeaks";
import type { SongLaneRenderProps, SongLaneType } from "./laneTypes";

const MAX_CLIP_BUCKETS = 1024;
const WAVE_COLOR = "rgb(233 241 238 / 0.7)";

type LaneClipProps = Pick<
  SongLaneRenderProps,
  "waveformSummaries" | "editable" | "onClipPointerDown" | "onClipContextMenu"
> & {
  clip: ClipSummary;
  leftPx: number;
  widthPx: number;
  heightPx: number;
  selected: boolean;
  trimmable: boolean;
  color: string | null;
};

/** One clip: a positioned box with its waveform on a small canvas, drawn
 * from the peaks the DAW already cached (the same builder as the song's
 * overview, over the clip's own span). */
function LaneClipComponent({
  clip,
  leftPx,
  widthPx,
  heightPx,
  selected,
  trimmable,
  color,
  waveformSummaries,
  editable,
  onClipPointerDown,
  onClipContextMenu,
}: LaneClipProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const summary = waveformSummaries[clip.waveformKey];
  const buckets = Math.max(1, Math.min(MAX_CLIP_BUCKETS, Math.round(widthPx)));
  const peaks = useMemo(
    () =>
      buildSongOverviewPeaks(
        [clip],
        summary ? { [clip.waveformKey]: summary } : {},
        { startSeconds: clip.timelineStartSeconds, endSeconds: clip.timelineStartSeconds + clip.durationSeconds },
        buckets,
      ),
    [buckets, clip, summary],
  );
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = buckets;
    canvas.height = Math.max(1, Math.round(heightPx));
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      context = null;
    }
    if (!context) return;
    const mid = canvas.height / 2;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = WAVE_COLOR;
    for (let index = 0; index < peaks.length; index += 1) {
      const half = Math.max(0.5, peaks[index] * mid * 0.9);
      context.fillRect(index, mid - half, 1, half * 2);
    }
  }, [buckets, heightPx, peaks]);

  return (
    <div
      className={`lt-setlist-lane-clip${selected ? " is-selected" : ""}`}
      data-lane-clip-id={clip.id}
      style={
        {
          left: `${leftPx}px`,
          width: `${widthPx}px`,
          "--lt-track-color": color ?? undefined,
        } as CSSProperties
      }
      title={clip.filePath.split(/[\\/]/).pop()}
      onPointerDown={editable ? (event) => onClipPointerDown(event, clip, "move") : undefined}
      onContextMenu={(event) => onClipContextMenu(event, clip)}
    >
      <canvas ref={canvasRef} className="lt-setlist-lane-clip-wave" aria-hidden="true" />
      <span className="lt-setlist-lane-clip-name">{clip.filePath.split(/[\\/]/).pop()}</span>
      {editable && trimmable ? (
        <>
          <span
            className="lt-setlist-lane-trim is-start"
            data-lane-trim="start"
            onPointerDown={(event) => onClipPointerDown(event, clip, "trimStart")}
          />
          <span
            className="lt-setlist-lane-trim is-end"
            data-lane-trim="end"
            onPointerDown={(event) => onClipPointerDown(event, clip, "trimEnd")}
          />
        </>
      ) : null}
    </div>
  );
}

const LaneClip = memo(LaneClipComponent);

/** The audio clips of one track inside the song. */
function AudioLaneComponent({
  track,
  song,
  region,
  scale,
  waveformSummaries,
  editable,
  onClipPointerDown,
  onClipContextMenu,
}: SongLaneRenderProps) {
  const selectedClipIds = useTimelineUIStore((state) => state.selectedClipIds);
  const clips = song.clips.filter(
    (clip) =>
      clip.trackId === track.id &&
      clip.timelineStartSeconds < region.endSeconds &&
      clip.timelineStartSeconds + clip.durationSeconds > region.startSeconds,
  );
  return (
    <div
      className="lt-setlist-lane is-audio"
      data-lane-track-id={track.id}
      data-lane-kind="audio"
    >
      {clips.map((clip) => (
        <LaneClip
          key={clip.id}
          clip={clip}
          leftPx={scale.secondsToPx(clip.timelineStartSeconds)}
          widthPx={Math.max(2, clip.durationSeconds * scale.pxPerSecond)}
          heightPx={AUDIO_LANE_HEIGHT - 6}
          selected={selectedClipIds.includes(clip.id)}
          // view time is source time only without warp (see laneGestures)
          trimmable={!region.warpEnabled}
          color={clip.color ?? track.color ?? null}
          waveformSummaries={waveformSummaries}
          editable={editable}
          onClipPointerDown={onClipPointerDown}
          onClipContextMenu={onClipContextMenu}
        />
      ))}
    </div>
  );
}

export const AudioLane = memo(AudioLaneComponent);

export const AUDIO_LANE_HEIGHT = 56;

export const audioLaneType: SongLaneType = {
  kind: "audio",
  rowHeight: AUDIO_LANE_HEIGHT,
  accepts: (track) => track.kind === "audio",
  render: (props) => <AudioLane {...props} />,
};
