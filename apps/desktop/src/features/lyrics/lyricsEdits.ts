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
  LyricsSoftware,
  LyricsStep,
  LyricsStepMode,
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

export function withStepMode(lyrics: RegionLyrics | null | undefined, stepMode: LyricsStepMode): RegionLyrics {
  return { ...(lyrics ?? emptyRegionLyrics()), stepMode };
}

/** Recorded steps replace the old ones of the sections they touch and turn
 * the song to recorded mode. */
export function withRecordedSteps(lyrics: RegionLyrics | null | undefined, steps: LyricsStep[]): RegionLyrics {
  const base = lyrics ?? emptyRegionLyrics();
  const touched = new Set(steps.map((step) => step.markerId));
  return {
    ...base,
    stepMode: "manual",
    steps: [...(base.steps ?? []).filter((step) => !touched.has(step.markerId)), ...steps],
  };
}
