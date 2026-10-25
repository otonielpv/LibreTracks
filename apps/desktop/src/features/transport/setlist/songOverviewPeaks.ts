import type {
  ClipSummary,
  SongRegionSummary,
  WaveformSummaryDto,
} from "@libretracks/shared/models";

import { selectWaveformLod } from "../Renderer/WaveformTileCache";

/**
 * The song's overview waveform, Playback-style: for each time bucket of the
 * song, the LOUDEST peak of the audio clips covering it. The maximum, not the
 * sum: with 30 tracks a sum saturates everywhere. It is the material, not
 * the mix, so track volume and mute do not count.
 *
 * Reads the waveform summaries the DAW already fetched (the panel's
 * `waveformCache`, fed by hooks/useSongWaveforms); asks the backend for
 * nothing. A clip whose summary has not arrived contributes 0 until it does.
 */
export function buildSongOverviewPeaks(
  clips: readonly ClipSummary[],
  summaries: Readonly<Record<string, WaveformSummaryDto>>,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
  buckets: number,
): Float32Array {
  const count = Math.max(0, Math.floor(buckets));
  const out = new Float32Array(count);
  const songStart = region.startSeconds;
  const songDuration = region.endSeconds - songStart;
  if (count === 0 || songDuration <= 0) return out;
  const bucketSeconds = songDuration / count;

  for (const clip of clips) {
    const clipStart = clip.timelineStartSeconds;
    const clipEnd = clipStart + clip.durationSeconds;
    if (clip.durationSeconds <= 0 || clipEnd <= songStart || clipStart >= region.endSeconds) {
      continue;
    }
    const summary = summaries[clip.waveformKey];
    const lod = selectWaveformLod(summary, count / songDuration);
    if (!summary || !lod || summary.sampleRate <= 0 || lod.resolutionFrames <= 0) continue;
    const bucketsPerSourceSecond = summary.sampleRate / lod.resolutionFrames;
    // Warp stretches the source window over the clip's timeline duration.
    const sourcePerTimeline =
      clip.sourceWindowDurationSeconds > 0
        ? clip.sourceWindowDurationSeconds / clip.durationSeconds
        : 1;

    const first = Math.max(0, Math.floor((clipStart - songStart) / bucketSeconds));
    const last = Math.min(count - 1, Math.ceil((clipEnd - songStart) / bucketSeconds) - 1);
    for (let bucket = first; bucket <= last; bucket += 1) {
      const t0 = Math.max(clipStart, songStart + bucket * bucketSeconds);
      const t1 = Math.min(clipEnd, songStart + (bucket + 1) * bucketSeconds);
      if (t1 <= t0) continue;
      const s0 = clip.sourceStartSeconds + (t0 - clipStart) * sourcePerTimeline;
      const s1 = clip.sourceStartSeconds + (t1 - clipStart) * sourcePerTimeline;
      const i0 = Math.max(0, Math.floor(s0 * bucketsPerSourceSecond));
      const i1 = Math.min(lod.bucketCount, Math.max(i0 + 1, Math.ceil(s1 * bucketsPerSourceSecond)));
      let peak = out[bucket];
      for (let index = i0; index < i1; index += 1) {
        peak = Math.max(
          peak,
          Math.abs(lod.minPeaks[index] ?? 0),
          Math.abs(lod.maxPeaks[index] ?? 0),
          Math.abs(lod.minPeaksRight[index] ?? 0),
          Math.abs(lod.maxPeaksRight[index] ?? 0),
        );
      }
      out[bucket] = Math.min(1, peak);
    }
  }
  return out;
}

/** Clips of the song, as a key that changes only when their placement or
 * their source window changes (not on mix changes). */
export function songOverviewClipsKey(
  clips: readonly ClipSummary[],
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
): string {
  return clips
    .filter(
      (clip) =>
        clip.timelineStartSeconds < region.endSeconds &&
        clip.timelineStartSeconds + clip.durationSeconds > region.startSeconds,
    )
    .map(
      (clip) =>
        `${clip.id}:${clip.waveformKey}:${clip.timelineStartSeconds}:${clip.durationSeconds}:${clip.sourceStartSeconds}:${clip.sourceWindowDurationSeconds}`,
    )
    .join("|");
}

/** The summaries those clips need, as a key that changes when one arrives
 * or grows (a partial summary while the analysis runs). */
export function songOverviewSummariesKey(
  clips: readonly ClipSummary[],
  summaries: Readonly<Record<string, WaveformSummaryDto>>,
): string {
  const keys = new Set(clips.map((clip) => clip.waveformKey));
  return Array.from(keys)
    .sort()
    .map((key) => {
      const summary = summaries[key];
      return summary ? `${key}:${summary.version}:${summary.analyzedSeconds ?? "done"}` : `${key}:-`;
    })
    .join("|");
}
