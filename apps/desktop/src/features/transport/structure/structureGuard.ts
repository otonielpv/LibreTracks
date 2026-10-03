import { useCallback } from "react";

import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import { getSong, useSongStore } from "../songStore";
import { appliedArrangementName } from "./arrangementName";
import { openStructureGuard, type StructureGuardRequest } from "./structureStore";

/**
 * Edit guard for songs with an applied arrangement.
 *
 * While an arrangement is applied, the song's content on the timeline IS
 * `build(original, blocks)`. Editing a clip or marker there would be lost the
 * next time the arrangement is applied, so the backend rejects it
 * (`song structure locked: …`) and the UI asks first: "This song has an
 * arrangement. Edit the original?".
 *
 * Edits check here BEFORE they start (a live drag must not get halfway and fail
 * on commit). The backend error is the safety net for paths the UI does not
 * cover (MIDI, the remote…), and opens the same dialog.
 */

/** Must match `DesktopError::SongStructureLocked` in infra/error.rs. */
export const STRUCTURE_LOCKED_PATTERN =
  /song structure locked: (\S+) arrangement=(.*)$/;

/** Same ownership rule as the backend: 1 ms of tolerance on the left and,
 * with two songs back to back, the one that STARTS there wins. */
export function regionAt(
  song: SongView | null,
  seconds: number,
): SongRegionSummary | null {
  let owner: SongRegionSummary | null = null;
  for (const region of song?.regions ?? []) {
    const inside =
      seconds >= region.startSeconds - 0.001 && seconds < region.endSeconds;
    if (inside && (!owner || region.startSeconds >= owner.startSeconds)) {
      owner = region;
    }
  }
  return owner;
}

function requestFor(region: SongRegionSummary): StructureGuardRequest | null {
  const arrangementName = appliedArrangementName(region);
  return arrangementName
    ? { regionId: region.id, regionName: region.name, arrangementName }
    : null;
}

/** The locked song at `seconds`, if any. */
export function lockedRegionAt(
  song: SongView | null,
  seconds: number,
): StructureGuardRequest | null {
  const region = regionAt(song, seconds);
  return region ? requestFor(region) : null;
}

/** The first locked song among these clips, if any. */
export function lockedRegionForClips(
  song: SongView | null,
  clipIds: readonly string[],
): StructureGuardRequest | null {
  if (!song) return null;
  for (const clipId of clipIds) {
    const clip =
      song.clips.find((candidate) => candidate.id === clipId) ??
      song.midiClips?.find((candidate) => candidate.id === clipId) ??
      song.videoClips?.find((candidate) => candidate.id === clipId);
    if (!clip) continue;
    const locked = lockedRegionAt(song, clip.timelineStartSeconds);
    if (locked) return locked;
  }
  return null;
}

/**
 * Ask before editing content at these positions. Returns `true` when the edit
 * may go ahead; otherwise opens the guard dialog and returns `false`.
 */
export function requestStructureEdit(seconds: readonly number[]): boolean {
  const song = getSong();
  for (const position of seconds) {
    const locked = lockedRegionAt(song, position);
    if (locked) {
      openStructureGuard(locked);
      return false;
    }
  }
  return true;
}

/** Same as `requestStructureEdit`, for clips by id. */
export function requestClipEdit(clipIds: readonly string[]): boolean {
  const locked = lockedRegionForClips(getSong(), clipIds);
  if (locked) {
    openStructureGuard(locked);
    return false;
  }
  return true;
}

/** Parses the backend's `SongStructureLocked` error. */
export function parseStructureLocked(
  error: unknown,
): { regionId: string; arrangementName: string } | null {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const match = STRUCTURE_LOCKED_PATTERN.exec(raw);
  return match ? { regionId: match[1], arrangementName: match[2] } : null;
}

/** If `error` is the guard's, opens the dialog. Returns whether it was. */
export function openStructureGuardFromError(
  error: unknown,
  song: SongView | null = getSong(),
): boolean {
  const locked = parseStructureLocked(error);
  if (!locked) return false;
  const region = song?.regions.find((r) => r.id === locked.regionId);
  openStructureGuard({
    regionId: locked.regionId,
    regionName: region?.name ?? locked.regionId,
    arrangementName: locked.arrangementName,
  });
  return true;
}

/** `isRegionLocked(regionId)` for components that gate an edit up front. */
export function useStructureGuard() {
  const regions = useSongStore((state) => state.song?.regions);
  const isRegionLocked = useCallback(
    (regionId: string) => {
      const region = regions?.find((candidate) => candidate.id === regionId);
      return Boolean(region && appliedArrangementName(region));
    },
    [regions],
  );
  return { isRegionLocked };
}
