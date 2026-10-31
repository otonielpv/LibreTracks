import {
  getEffectiveBpmAt,
  markerCategory,
  markerColor,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";

import { getBeatDurationSeconds, parseTimeSignature } from "../timeline/timelineMath";
import {
  buildLiveMarkerGroups,
  liveMarkerGroupsForRegion,
} from "../live/liveMarkerModel";

/** One block of the song map: a section, or the stretch before the first
 * one ("Start"), or the whole song when it has no sections. */
export type SongMapBlock = {
  id: string;
  /** The section marker; `null` for the implicit start / whole-song block,
   * which jumps to the song's start instead of to a marker. */
  marker: SectionMarkerSummary | null;
  kind: "section" | "start" | "song";
  label: string;
  color: string | null;
  digit: number | null;
  startSeconds: number;
  endSeconds: number;
  bars: number;
  /** Share of the song's length; all blocks add up to exactly 1. */
  widthFraction: number;
  /** Cues at the same point as the section, folded into it. */
  cues: SectionMarkerSummary[];
};

/** A cue that does not sit on a section: drawn as a notch, not a block. */
export type SongMapNotch = {
  marker: SectionMarkerSummary;
  fraction: number;
};

export type SongMap = { blocks: SongMapBlock[]; notches: SongMapNotch[] };

/** Within this, a first section counts as starting at the song start. */
const START_EPSILON_SECONDS = 0.02;
/** Same tolerance as resolveLivePlaybackPosition: a marker owns its exact
 * start even if the sampled clock lands a hair before it. */
const ACTIVE_EPSILON_SECONDS = 0.001;

/** Seconds per bar at a point of the song: tempo and meter in force there. */
export type BarSecondsAt = (seconds: number) => number;

export function barSecondsAtFor(song: SongView): BarSecondsAt {
  return (seconds) => {
    let signature = song.timeSignature;
    for (const marker of song.timeSignatureMarkers ?? []) {
      if (marker.startSeconds <= seconds + ACTIVE_EPSILON_SECONDS) {
        signature = marker.signature;
      }
    }
    const bpm = getEffectiveBpmAt(song, seconds);
    return (
      getBeatDurationSeconds(bpm, signature) *
      parseTimeSignature(signature).beatsPerBar
    );
  };
}

function barsBetween(start: number, end: number, barSecondsAt: BarSecondsAt) {
  const barSeconds = barSecondsAt(start);
  return barSeconds > 0 ? (end - start) / barSeconds : 0;
}

export function buildSongMapBlocks(
  region: SongRegionSummary,
  markers: readonly SectionMarkerSummary[],
  barSecondsAt: BarSecondsAt,
  labels: { start: string },
): SongMap {
  const regionStart = region.startSeconds;
  const regionEnd = region.endSeconds;
  const total = Math.max(0, regionEnd - regionStart);
  const groups = liveMarkerGroupsForRegion(buildLiveMarkerGroups(markers), region);
  const sections = groups.filter((group) => group.category === "section");
  const notches: SongMapNotch[] = groups
    .filter((group) => group.category === "cue")
    .map((group) => ({
      marker: group.primary,
      fraction: total > 0 ? (group.startSeconds - regionStart) / total : 0,
    }));

  const blocks: Omit<SongMapBlock, "widthFraction" | "endSeconds" | "bars">[] = [];
  if (sections.length === 0) {
    blocks.push({
      id: `song:${region.id}`,
      marker: null,
      kind: "song",
      label: region.name,
      color: null,
      digit: null,
      startSeconds: regionStart,
      cues: [],
    });
  } else {
    if (sections[0].startSeconds > regionStart + START_EPSILON_SECONDS) {
      blocks.push({
        id: `start:${region.id}`,
        marker: null,
        kind: "start",
        label: labels.start,
        color: null,
        digit: null,
        startSeconds: regionStart,
        cues: [],
      });
    }
    for (const group of sections) {
      blocks.push({
        id: group.id,
        marker: group.primary,
        kind: "section",
        label: group.primary.name,
        color: markerColor(group.primary),
        digit: group.primary.digit ?? null,
        startSeconds: group.startSeconds,
        cues: group.cues,
      });
    }
  }

  let used = 0;
  const finished = blocks.map<SongMapBlock>((block, index) => {
    const endSeconds = blocks[index + 1]?.startSeconds ?? regionEnd;
    const isLast = index === blocks.length - 1;
    // The last block takes whatever rounding left over, so the sum is 1.
    const widthFraction = isLast
      ? Math.max(0, 1 - used)
      : total > 0
        ? (endSeconds - block.startSeconds) / total
        : 0;
    used += widthFraction;
    return {
      ...block,
      endSeconds,
      bars: barsBetween(block.startSeconds, endSeconds, barSecondsAt),
      widthFraction,
    };
  });

  return { blocks: finished, notches };
}

export type ActiveBlock = {
  activeId: string | null;
  nextId: string | null;
  /** 0..1 inside the active block; 0 without one. */
  progress: number;
};

/** Which block the playhead is in. Outside the song: no active block, and
 * the first block is "next" while the playhead is still before the song. */
export function resolveActiveBlock(
  blocks: readonly SongMapBlock[],
  positionSeconds: number,
): ActiveBlock {
  if (blocks.length === 0) return { activeId: null, nextId: null, progress: 0 };
  const songEnd = blocks[blocks.length - 1].endSeconds;
  if (positionSeconds >= songEnd) return { activeId: null, nextId: null, progress: 0 };
  let activeIndex = -1;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].startSeconds <= positionSeconds + ACTIVE_EPSILON_SECONDS) {
      activeIndex = index;
    } else {
      break;
    }
  }
  if (activeIndex < 0) {
    return { activeId: null, nextId: blocks[0].id, progress: 0 };
  }
  const active = blocks[activeIndex];
  const span = active.endSeconds - active.startSeconds;
  return {
    activeId: active.id,
    nextId: blocks[activeIndex + 1]?.id ?? null,
    progress:
      span > 0
        ? Math.max(0, Math.min(1, (positionSeconds - active.startSeconds) / span))
        : 0,
  };
}

/** The song the map shows: the selected one, else the one it showed last
 * (a section menu clears the song selection, like in the DAW), else the
 * sounding one, else the first. */
/**
 * The 1-based `jump_marker_N` index of each section, as the MIDI dispatch
 * counts them: sections only (cues are not jump targets), in time order.
 */
export function sectionJumpIndexes(
  markers: readonly SectionMarkerSummary[],
): Map<string, number> {
  return new Map(
    markers
      .filter((marker) => markerCategory(marker) === "section")
      .sort((left, right) => left.startSeconds - right.startSeconds)
      .map((marker, index) => [marker.id, index + 1]),
  );
}

export function resolveSetlistSongId(
  regions: readonly SongRegionSummary[],
  selectedRegionId: string | null,
  lastShownRegionId: string | null,
  activeRegionId: string | null,
): string | null {
  const exists = (id: string | null) =>
    id !== null && regions.some((region) => region.id === id);
  if (exists(selectedRegionId)) return selectedRegionId;
  if (exists(lastShownRegionId)) return lastShownRegionId;
  if (exists(activeRegionId)) return activeRegionId;
  return regions[0]?.id ?? null;
}

/** The block a marker id (section or folded cue) belongs to. */
export function blockIdForMarker(
  blocks: readonly SongMapBlock[],
  markerId: string | null,
): string | null {
  if (!markerId) return null;
  const block = blocks.find(
    (candidate) =>
      candidate.marker?.id === markerId ||
      candidate.cues.some((cue) => cue.id === markerId),
  );
  return block?.id ?? null;
}
