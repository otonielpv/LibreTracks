import type { ClipSummary, SongView, TrackSummary } from "../desktopApi";

export function requireSeconds(value: string): number {
  const seconds = Number(value);
  if (!value.trim() || !Number.isFinite(seconds) || seconds < 0) throw new Error("invalid");
  return seconds;
}

export function songClips(song: SongView, regionId: string) {
  const region = song.regions.find((item) => item.id === regionId);
  return region ? song.clips.filter((clip) => clip.timelineStartSeconds < region.endSeconds &&
    clip.timelineStartSeconds + clip.durationSeconds > region.startSeconds) : song.clips;
}

export function clipPlacements(clips: ClipSummary[], startSeconds: number, targetTrackId?: string) {
  if (!clips.length) throw new Error("selectionRequired");
  const origin = Math.min(...clips.map((clip) => clip.timelineStartSeconds));
  return clips.map((clip) => ({ clipId: clip.id,
    timelineStartSeconds: startSeconds + clip.timelineStartSeconds - origin,
    ...(targetTrackId ? { targetTrackId } : {}),
  }));
}

export function canParentTrack(tracks: TrackSummary[], trackId: string, parentId: string) {
  const visited = new Set<string>([trackId]);
  let current: string | null | undefined = parentId;
  while (current) {
    if (visited.has(current)) return false;
    visited.add(current);
    const parent = tracks.find((track) => track.id === current);
    if (!parent || parent.kind !== "folder") return false;
    current = parent.parentTrackId;
  }
  return true;
}
