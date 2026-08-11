/**
 * Pure derivations for the remote's marker surfaces (the timeline ribbon and
 * the jump grid). Kept free of React so the pairing rules can be unit-tested;
 * the components live in App.tsx where the stores and sendCommand already are.
 *
 * The remote used to show ONLY section markers: dynamic cues (Build, All In,
 * ...) are spoken by the voice guide, so they were filtered out everywhere. On
 * stage that hides information the musician needs — a cue is still a point in
 * the song, and a valid place to jump to. Cues are now shown and jumpable; the
 * pairing rule only decides where they are DRAWN. A cue sitting on top of a
 * section rides inside that section's card (one card per point on the
 * timeline), and a lone cue gets its own, visibly different card.
 */

import { markerCategory, type SectionMarkerSummary } from "@libretracks/shared/models";

/** How close a cue must be to a section to be considered "the same point".
 * Markers are stored in seconds and the desktop snaps them to the grid, so an
 * exact equality test would miss pairs that differ by float noise. A few
 * milliseconds is far below anything a human places by hand. */
export const MARKER_PAIR_TOLERANCE_SECONDS = 0.02;

/**
 * One card in the remote's marker grid. Either a section (with any cues that
 * share its position attached) or a lone cue. Both are jump targets; the kind
 * only drives how the card is drawn.
 */
export type MarkerCardEntry = {
  /** Stable key: the id of the marker that owns the card, and the marker a jump
   * from this card targets. */
  id: string;
  /** The marker the card is built around. */
  marker: SectionMarkerSummary;
  /** Which family the card's own marker belongs to — presentation only. */
  kind: "section" | "cue";
  /** Cues sharing this section's position, in timeline order. Always empty on a
   * cue card. */
  cues: SectionMarkerSummary[];
};

function byStart(a: SectionMarkerSummary, b: SectionMarkerSummary): number {
  return a.startSeconds - b.startSeconds;
}

/**
 * Split markers into sections and cues, attaching every cue to the section it
 * shares a position with. Cues with no section at their point are returned as
 * standalone entries. The result is ordered by timeline position, so a lone cue
 * appears between the sections it falls between rather than in a separate
 * block.
 */
export function buildMarkerCards(
  markers: readonly SectionMarkerSummary[],
): MarkerCardEntry[] {
  const sections: SectionMarkerSummary[] = [];
  const cues: SectionMarkerSummary[] = [];
  for (const marker of markers) {
    (markerCategory(marker) === "section" ? sections : cues).push(marker);
  }
  sections.sort(byStart);
  cues.sort(byStart);

  const entries = new Map<string, MarkerCardEntry>();
  const ordered: MarkerCardEntry[] = [];
  for (const section of sections) {
    const entry: MarkerCardEntry = {
      id: section.id,
      marker: section,
      kind: "section",
      cues: [],
    };
    entries.set(section.id, entry);
    ordered.push(entry);
  }

  for (const cue of cues) {
    const host = nearestSectionAt(sections, cue.startSeconds);
    if (host) {
      entries.get(host.id)?.cues.push(cue);
      continue;
    }
    ordered.push({ id: cue.id, marker: cue, kind: "cue", cues: [] });
  }

  ordered.sort((a, b) => a.marker.startSeconds - b.marker.startSeconds);
  return ordered;
}

/** The section within {@link MARKER_PAIR_TOLERANCE_SECONDS} of a position, or
 * null. When several qualify (markers stacked on the same beat) the closest
 * one wins, so a cue never attaches to a farther section than it could. */
function nearestSectionAt(
  sections: readonly SectionMarkerSummary[],
  seconds: number,
): SectionMarkerSummary | null {
  let best: SectionMarkerSummary | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const section of sections) {
    const distance = Math.abs(section.startSeconds - seconds);
    if (distance <= MARKER_PAIR_TOLERANCE_SECONDS && distance < bestDistance) {
      best = section;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * One label on the timeline ribbon. Sections and lone cues each get their own
 * chip; a cue stacked on a section is folded into that section's chip as a
 * suffix, so two markers on the same beat never render one on top of the other.
 */
export type TimelineMarkerChip = {
  id: string;
  kind: "section" | "cue";
  startSeconds: number;
  color: string;
  label: string;
  /** Cue names folded into a section chip (empty for cue chips). */
  cueNames: string[];
};

/**
 * Chips for the timeline ribbon, built with the same pairing rule as the grid
 * so both surfaces agree on what sits where.
 */
export function buildTimelineMarkerChips(
  markers: readonly SectionMarkerSummary[],
  colorOf: (marker: SectionMarkerSummary) => string,
): TimelineMarkerChip[] {
  return buildMarkerCards(markers).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    startSeconds: entry.marker.startSeconds,
    color: colorOf(entry.marker),
    label: entry.marker.name,
    cueNames: entry.cues.map((cue) => cue.name),
  }));
}
