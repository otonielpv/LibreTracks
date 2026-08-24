import {
  markerCategory,
  type SectionMarkerSummary,
  type SongRegionSummary,
} from "@libretracks/shared/models";

export const LIVE_MARKER_PAIR_TOLERANCE_SECONDS = 0.02;

export type LiveMarkerGroup = {
  id: string;
  primary: SectionMarkerSummary;
  category: "section" | "cue";
  cues: SectionMarkerSummary[];
  startSeconds: number;
};

export type LivePlaybackPosition = {
  positionSeconds: number;
  activeGroupId: string | null;
  nextGroupId: string | null;
  currentRegionId: string | null;
  nextRegionId: string | null;
  secondsToNextGroup: number | null;
  progressPercent: number;
};

function byStart(left: SectionMarkerSummary, right: SectionMarkerSummary) {
  return left.startSeconds - right.startSeconds;
}

/**
 * Produces one live-view row per point on the timeline. Warning/cue markers
 * that share a position with a section are folded into that section's row;
 * lone cues remain first-class rows. This mirrors the proven Remote rule.
 */
export function buildLiveMarkerGroups(
  markers: readonly SectionMarkerSummary[],
): LiveMarkerGroup[] {
  const sections = markers
    .filter((marker) => markerCategory(marker) === "section")
    .sort(byStart);
  const cues = markers
    .filter((marker) => markerCategory(marker) === "cue")
    .sort(byStart);

  const groups = sections.map<LiveMarkerGroup>((section) => ({
    id: section.id,
    primary: section,
    category: "section",
    cues: [],
    startSeconds: section.startSeconds,
  }));

  for (const cue of cues) {
    let nearest: LiveMarkerGroup | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      const distance = Math.abs(group.startSeconds - cue.startSeconds);
      if (
        distance <= LIVE_MARKER_PAIR_TOLERANCE_SECONDS &&
        distance < nearestDistance
      ) {
        nearest = group;
        nearestDistance = distance;
      }
    }

    if (nearest) {
      nearest.cues.push(cue);
    } else {
      groups.push({
        id: cue.id,
        primary: cue,
        category: "cue",
        cues: [],
        startSeconds: cue.startSeconds,
      });
    }
  }

  return groups.sort((left, right) => left.startSeconds - right.startSeconds);
}

export function groupContainsMarker(group: LiveMarkerGroup, markerId: string) {
  return (
    group.primary.id === markerId ||
    group.cues.some((cue) => cue.id === markerId)
  );
}

export function liveMarkerGroupsForRegion(
  groups: readonly LiveMarkerGroup[],
  region: SongRegionSummary | null,
) {
  if (!region) return [...groups];
  return groups.filter(
    (group) =>
      group.startSeconds >= region.startSeconds &&
      group.startSeconds < region.endSeconds,
  );
}

/** Pure playback derivation; safe to call from a throttled UI timer. */
export function resolveLivePlaybackPosition(
  groups: readonly LiveMarkerGroup[],
  regions: readonly SongRegionSummary[],
  positionSeconds: number,
): LivePlaybackPosition {
  const position = Number.isFinite(positionSeconds)
    ? Math.max(0, positionSeconds)
    : 0;
  let activeIndex = -1;
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index].startSeconds <= position + 0.001) activeIndex = index;
    else break;
  }

  const active = activeIndex >= 0 ? groups[activeIndex] : null;
  const next = groups[activeIndex + 1] ?? null;
  const span = active && next ? next.startSeconds - active.startSeconds : 0;
  const progress =
    active && next && span > 0
      ? (position - active.startSeconds) / span
      : active
        ? 1
        : 0;
  const currentRegion =
    regions.find(
      (region) =>
        position >= region.startSeconds && position < region.endSeconds,
    ) ?? null;
  const sortedRegions = [...regions].sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );
  const currentRegionIndex = currentRegion
    ? sortedRegions.findIndex((region) => region.id === currentRegion.id)
    : -1;
  const nextRegion =
    currentRegionIndex >= 0
      ? (sortedRegions[currentRegionIndex + 1] ?? null)
      : (sortedRegions.find((region) => region.startSeconds > position) ?? null);

  return {
    // Keep the sampled position exact. Rounding here made consumers that
    // derive the active row switch as much as half a second before/after a
    // marker. Labels round only at their formatting boundary.
    positionSeconds: position,
    activeGroupId: active?.id ?? null,
    nextGroupId: next?.id ?? null,
    currentRegionId: currentRegion?.id ?? null,
    nextRegionId: nextRegion?.id ?? null,
    secondsToNextGroup: next
      ? Math.max(0, Math.round(next.startSeconds - position))
      : null,
    progressPercent: Math.round(Math.max(0, Math.min(1, progress)) * 100),
  };
}

export function formatLiveClock(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
