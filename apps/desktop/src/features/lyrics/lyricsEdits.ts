/**
 * Pure edits of the lyrics settings and of a song's `RegionLyrics` (plan
 * lyrics-sync). The handlers call these and then save; the views never edit
 * the model themselves.
 */
import type {
  LeadTime,
  LyricsConfig,
  LyricsLink,
  LyricsOverrideTarget,
  LyricsSlideTiming,
  LyricsSoftware,
  LyricsStartTarget,
  LyricsStep,
  RegionLyrics,
} from "@libretracks/shared/models";

import { DEFAULT_PORTS } from "./lyricsApi";

export const DEFAULT_LYRICS_CONFIG: LyricsConfig = {
  enabled: false,
  software: null,
  host: "127.0.0.1",
  port: null,
  lead: { unit: "beats", count: 1 },
  clearOnSongEnd: true,
  clearOnStop: false,
  paused: false,
  tutorialDone: [],
};

/** Switch program. The port follows the program's default unless the user
 * typed one (`portTouched`). */
export function withSoftware(
  config: LyricsConfig,
  software: LyricsSoftware,
  portTouched: boolean,
): LyricsConfig {
  return {
    ...config,
    software,
    port: portTouched ? config.port : DEFAULT_PORTS[software],
  };
}

export function emptyRegionLyrics(): RegionLyrics {
  return { enabled: true, links: [], steps: [], stepMode: "auto", lead: null };
}

/** The link of a program, if any. */
export function linkFor(lyrics: RegionLyrics | null | undefined, software: LyricsSoftware) {
  return lyrics?.links.find((link) => link.software === software) ?? null;
}

/** Link a song to a presentation, keeping the corrections already made for
 * that program and the links of the others. */
export function withPresentation(
  lyrics: RegionLyrics | null | undefined,
  software: LyricsSoftware,
  presentation: { id: string; name: string },
): RegionLyrics {
  const base = lyrics ?? emptyRegionLyrics();
  const existing = linkFor(base, software);
  const link: LyricsLink = {
    software,
    presentationId: presentation.id,
    presentationName: presentation.name,
    overrides: existing?.overrides ?? [],
    // Slide indexes belong to that presentation: a new one starts clean.
    slides: existing?.presentationId === presentation.id ? (existing?.slides ?? []) : [],
    start: existing?.presentationId === presentation.id ? (existing?.start ?? null) : null,
  };
  return {
    ...base,
    links: [...base.links.filter((other) => other.software !== software), link],
  };
}

/** The id an override is stored under: the base id (every repeat) or the
 * exact `~n` id (only that time). */
export function overrideMarkerId(markerId: string, onlyThisTime: boolean): string {
  return onlyThisTime ? markerId : markerId.split("~")[0];
}

/** Set (or with `target: null`, remove) a correction of a marker. */
export function withOverride(
  lyrics: RegionLyrics | null | undefined,
  software: LyricsSoftware,
  markerId: string,
  target: LyricsOverrideTarget | null,
  onlyThisTime: boolean,
): RegionLyrics {
  const base = lyrics ?? emptyRegionLyrics();
  const link = linkFor(base, software);
  if (!link) return base;
  const id = overrideMarkerId(markerId, onlyThisTime);
  const overrides = (link.overrides ?? []).filter((entry) => entry.markerId !== id);
  if (target) overrides.push({ markerId: id, target });
  return {
    ...base,
    links: base.links.map((other) => (other.software === software ? { ...link, overrides } : other)),
  };
}

export function withEnabled(lyrics: RegionLyrics | null | undefined, enabled: boolean): RegionLyrics {
  return { ...(lyrics ?? emptyRegionLyrics()), enabled };
}

export function withLead(lyrics: RegionLyrics | null | undefined, lead: LeadTime | null): RegionLyrics {
  return { ...(lyrics ?? emptyRegionLyrics()), lead };
}

/** Whether a marker id is a repeat written by an arrangement (`"c~2"`). */
export function isRepeat(markerId: string): boolean {
  return markerId.includes("~");
}

/** Change the link of the current program; nothing without one. */
function withLink(
  lyrics: RegionLyrics | null | undefined,
  software: LyricsSoftware,
  change: (link: LyricsLink) => LyricsLink,
): RegionLyrics {
  const base = lyrics ?? emptyRegionLyrics();
  const link = linkFor(base, software);
  if (!link) return base;
  return {
    ...base,
    links: base.links.map((other) => (other.software === software ? change(link) : other)),
  };
}

/** Slides chosen by hand for some markers (exact ids); an empty list gives a
 * marker back to its group. One save for all of them. */
export function withSlides(
  lyrics: RegionLyrics | null | undefined,
  software: LyricsSoftware,
  chosen: Array<{ markerId: string; indexes: number[] }>,
): RegionLyrics {
  const touched = new Set(chosen.map((entry) => entry.markerId));
  return withLink(lyrics, software, (link) => ({
    ...link,
    slides: [
      ...(link.slides ?? []).filter((entry) => !touched.has(entry.markerId)),
      ...chosen.filter((entry) => entry.indexes.length > 0),
    ],
  }));
}

/** What shows when the song starts; `null` = automatic. */
export function withStart(
  lyrics: RegionLyrics | null | undefined,
  software: LyricsSoftware,
  start: LyricsStartTarget | null,
): RegionLyrics {
  return withLink(lyrics, software, (link) => ({ ...link, start }));
}

/** How one marker's slides change (exact id: only that repeat). */
export function withTiming(
  lyrics: RegionLyrics | null | undefined,
  markerId: string,
  timing: LyricsSlideTiming,
): RegionLyrics {
  const base = lyrics ?? emptyRegionLyrics();
  return {
    ...base,
    sections: [
      ...(base.sections ?? []).filter((entry) => entry.markerId !== markerId),
      { markerId, timing },
    ],
  };
}

/** A marker's own lead (exact id: only that repeat); `null` = the song's. */
export function withMarkerLead(
  lyrics: RegionLyrics | null | undefined,
  markerId: string,
  lead: LeadTime | null,
): RegionLyrics {
  const base = lyrics ?? emptyRegionLyrics();
  const leads = (base.leads ?? []).filter((entry) => entry.markerId !== markerId);
  if (lead) leads.push({ markerId, lead });
  return { ...base, leads };
}

/** A section's recording replaces that marker's own steps and turns it to
 * recorded. */
export function withSectionRecording(
  lyrics: RegionLyrics | null | undefined,
  markerId: string,
  steps: LyricsStep[],
): RegionLyrics {
  const base = withTiming(lyrics, markerId, { type: "recorded" });
  return {
    ...base,
    steps: [...(base.steps ?? []).filter((step) => step.markerId !== markerId), ...steps],
  };
}

/** Split `indexes` in order among `count` markers, as evenly as possible:
 * 4 slides over 4 repeats = one each; fewer slides than repeats = the last
 * ones repeat the last slide. */
export function spreadSlides(indexes: number[], count: number): number[][] {
  if (count <= 0 || indexes.length === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * indexes.length) / count);
    const to = Math.floor(((i + 1) * indexes.length) / count);
    return to > from ? indexes.slice(from, to) : [indexes[Math.min(from, indexes.length - 1)]];
  });
}
