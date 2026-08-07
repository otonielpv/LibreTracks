import { useEffect, useMemo, useRef, useState } from "react";

import type { SongView } from "@libretracks/shared/models";

import { buildVisibleTracks } from "../helpers";
import {
  toAutomationTrack,
  toPendingTrack,
  type PendingAudioImport,
  type TimelineTrackSummary,
} from "../library/pendingAudioImports";

export type UseVisibleTracksOptions = {
  song: SongView | null;
  pendingAudioImports: PendingAudioImport[];
  /** Localised name for the synthetic automation lane. */
  automationTrackName: string;
};

/** Folder ids the song says are collapsed, in a set the caller can diff. */
function collapsedIdsOf(song: SongView): Set<string> {
  return new Set(
    song.tracks
      .filter((track) => track.kind === "folder" && track.collapsed === true)
      .map((track) => track.id),
  );
}

function sameIds(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * Owns which folders are collapsed and derives the rows the arrangement draws.
 *
 * The collapsed flag is persisted per track, but the arrangement reads it from
 * a local `Set` so a click folds on the same frame instead of waiting for a
 * round-trip. This hook keeps that set seeded from the loaded song: on load,
 * and on any later song whose collapsed flags differ from what it last applied,
 * it replaces the local set with the song's.
 *
 * It tracks the last set it applied rather than comparing against the live one,
 * because the two legitimately disagree for a moment on every toggle: the click
 * updates the local set immediately and the snapshot carrying the same change
 * arrives after. Diffing against the live set would treat that in-flight window
 * as a change to undo and snap the folder back open.
 *
 * The visible-track list lives here too because collapsing is the only thing
 * that hides a row — keeping the set and its one consumer together is what lets
 * both stay out of TransportPanelContent.
 */
export function useVisibleTracks({
  song,
  pendingAudioImports,
  automationTrackName,
}: UseVisibleTracksOptions) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const lastAppliedRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!song) {
      // A closed session starts the next one from a clean slate.
      lastAppliedRef.current = null;
      return;
    }

    const collapsedIds = collapsedIdsOf(song);
    const lastApplied = lastAppliedRef.current;
    if (lastApplied && sameIds(lastApplied, collapsedIds)) {
      return;
    }

    lastAppliedRef.current = collapsedIds;
    setCollapsedFolders(collapsedIds);
  }, [song]);

  const visibleTracks = useMemo<TimelineTrackSummary[]>(() => {
    const realTracks: TimelineTrackSummary[] = song
      ? buildVisibleTracks(song, collapsedFolders)
      : [];

    // Inject the synthetic automation lane (if the user added it) at the saved
    // position: after the track whose id is `afterTrackId`, or first when null.
    // It is not a real song track — see toAutomationTrack().
    if (song?.automationTrack) {
      const afterId = song.automationTrack.afterTrackId ?? null;
      const automationRow = toAutomationTrack(automationTrackName);
      if (afterId === null) {
        realTracks.unshift(automationRow);
      } else {
        const anchorIndex = realTracks.findIndex(
          (track) => track.id === afterId,
        );
        if (anchorIndex >= 0) {
          realTracks.splice(anchorIndex + 1, 0, automationRow);
        } else {
          // Anchor track no longer visible/exists: fall back to the top.
          realTracks.unshift(automationRow);
        }
      }
    }

    return [
      ...realTracks,
      ...pendingAudioImports
        .filter((pendingImport) => pendingImport.showInTimeline)
        .map(toPendingTrack),
    ];
  }, [automationTrackName, collapsedFolders, pendingAudioImports, song]);

  return { collapsedFolders, setCollapsedFolders, visibleTracks };
}
