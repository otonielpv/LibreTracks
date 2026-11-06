import { useCallback } from "react";

import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import { markerCategory } from "../markerKinds";
import { getSong, useSongStore } from "../songStore";
import { appliedArrangementName } from "./arrangementName";
import { openStructureGuard, type StructureGuardRequest } from "./structureStore";

/**
 * Edit guard for songs with an applied arrangement.
 *
 * Clips, MIDI, video, cue markers and automation cues are free: an edit there
 * stays in the block it falls in (the backend keeps it as that block's own
 * content). What changes the song's SHAPE is not: section markers, tempo,
 * meter, key and the song's length come from the original, so the backend
 * rejects them (`song structure locked: …`) and the UI asks first: "This song
 * has an arrangement. Edit the original?".
 *
 * Shape edits check here BEFORE they start (a live drag must not get halfway
 * and fail on commit). The backend error is the safety net for paths the UI
 * does not cover (menus, MIDI, the remote…), and opens the same dialog.
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

/** Same as `requestStructureEdit`, for markers by id: only SECTION markers
 * are guarded (they are the blocks); cue markers are free. */
export function requestMarkerEdit(markerIds: readonly string[]): boolean {
  const song = getSong();
  const sectionStarts = markerIds
    .map((id) => song?.sectionMarkers.find((marker) => marker.id === id))
    .filter((marker): marker is NonNullable<typeof marker> => Boolean(marker))
    .filter((marker) => markerCategory(marker) === "section")
    .map((marker) => marker.startSeconds);
  return requestStructureEdit(sectionStarts);
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
