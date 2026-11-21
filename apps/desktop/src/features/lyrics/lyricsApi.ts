/**
 * Lyrics sync commands and events (plan lyrics-sync). Every request to the
 * lyrics program goes through Rust: the WebView never talks to it (Android
 * release blocks the WebView's cleartext).
 */
import {
  invokeCommand,
  pauseTransport,
  playTransport,
  seekTransport,
} from "@libretracks/shared/desktopApi";

export { pauseTransport, playTransport, seekTransport };
import type {
  LeadTime,
  LyricsConfig,
  LyricsLink,
  LyricsSlideTiming,
  LyricsSoftware,
  LyricsStep,
  RegionLyrics,
} from "@libretracks/shared/models";

export type { LyricsConfig, LyricsSoftware };

export type LyricsConfigView = {
  config: LyricsConfig;
  /** A token is stored for the selected program (the token never comes back). */
  hasToken: boolean;
};

export type ProbeInfo = { version: string; presentations: number };

export type LyricsError =
  | { kind: "unreachable"; detail: string }
  | { kind: "timeout" }
  | { kind: "unauthorized"; missing: string[] }
  | { kind: "notFound"; what: string }
  | { kind: "unexpected"; detail: string };

export type LyricsConnection =
  | { state: "disabled" }
  | { state: "paused" }
  | { state: "connecting" }
  | { state: "ok" }
  | { state: "unreachable" }
  | { state: "unauthorized"; missing: string[] };

export type LyricsLastSent = {
  regionId: string;
  markerId: string | null;
  markerName: string | null;
  label: string | null;
  latencyMs: number;
  atUnixMs: number;
};

export type LyricsStatus = {
  connection: LyricsConnection;
  lastSent: LyricsLastSent | null;
  lastError: string | null;
  unlinkedSongs: number;
};

export type Presentation = { id: string; name: string };

export type MarkerStatus =
  | { status: "matched"; groupLabel: string; automatic: boolean }
  | { status: "clear" }
  | { status: "clearText" }
  | { status: "skip" }
  | { status: "unmatched" };

export type MarkerReport = MarkerStatus & {
  markerId: string;
  markerName: string;
  occurrence: number;
  startSeconds: number;
  slideCount: number;
  /** The program's indexes of the slides this marker shows. */
  slides: number[];
  /** Chosen by hand in the section editor. */
  customSlides: boolean;
  /** Where the next section (or the song) starts, source seconds. */
  endSeconds: number;
  /** One bar before the marker: where the section recorder starts playing. */
  countInSeconds: number;
  timing: LyricsSlideTiming;
  /** Its own lead; null = the song's (or the global one). */
  lead: LeadTime | null;
  /** The bar of the section each slide change falls on, by its timing. */
  changePoints: Array<{ bar: number; beat: number }>;
};

/** One slide of the presentation as the program numbers it. */
export type SlideInfo = {
  index: number;
  groupLabel: string;
  text: string;
  /** The slide the program adds with the song's title (Holyrics). */
  title?: boolean;
};

export type RegionReport = {
  regionId: string;
  regionName: string;
  linkState: { state: "linked" } | { state: "suggested" } | { state: "notFound" };
  link: LyricsLink | null;
  stored: boolean;
  groups: Array<{ label: string; slideCount: number }>;
  markers: MarkerReport[];
  suggestions: Array<{ id: string; name: string; score: number }>;
  unmatchedSections: number;
  /** Every slide of the presentation (linked songs only). */
  slides?: SlideInfo[];
  /** What shows when the song starts before its first section; `slide`
   * null = blank screen. */
  start?: { automatic: boolean; slide: number | null; clearText?: boolean } | null;
};

export const LYRICS_STATUS_EVENT = "lyrics:status";
export const LYRICS_LINK_EVENT = "lyrics:link";

/** Default port per program; ProPresenter picks its own. Mirror of Rust. */
export const DEFAULT_PORTS: Record<LyricsSoftware, number | null> = {
  proPresenter: null,
  freeShow: 5506,
  holyrics: 8091,
  unknown: null,
};

export const LYRICS_PROGRAMS: Array<Exclude<LyricsSoftware, "unknown">> = [
  "proPresenter",
  "freeShow",
  "holyrics",
];

export function usesToken(software: LyricsSoftware | null): boolean {
  return software === "freeShow" || software === "holyrics";
}

export function getLyricsConfig() {
  return invokeCommand<LyricsConfigView>("lyrics_get_config");
}

/** `token`: `undefined` keeps the stored one, `""` forgets it. Never part of
 * the config itself. */
export function saveLyricsConfig(config: LyricsConfig, token?: string) {
  return invokeCommand<LyricsConfigView>("lyrics_save_config", {
    config,
    token: token ?? null,
  });
}

export function probeLyrics(software: LyricsSoftware, host: string, port: number, token?: string) {
  return invokeCommand<ProbeInfo>("lyrics_probe", { software, host, port, token: token ?? null });
}

export function listPresentations() {
  return invokeCommand<Presentation[]>("lyrics_list_presentations");
}

export function getRegionReport(regionId: string) {
  return invokeCommand<RegionReport>("lyrics_region_report", { regionId });
}

export function getSetlistReport() {
  return invokeCommand<RegionReport[]>("lyrics_setlist_report");
}

export function setRegionLyrics(regionId: string, lyrics: RegionLyrics | null) {
  return invokeCommand<unknown>("lyrics_set_region_lyrics", { regionId, lyrics });
}

export function testSendLyrics(regionId: string, markerId: string, k: number) {
  return invokeCommand<void>("lyrics_test_send", { regionId, markerId, k });
}

export function setLyricsPaused(paused: boolean) {
  return invokeCommand<void>("lyrics_set_paused", { paused });
}

export function refreshLyrics() {
  return invokeCommand<void>("lyrics_refresh");
}

export function getLyricsStatus() {
  return invokeCommand<LyricsStatus>("lyrics_status");
}

export function markLyricsTutorialDone(software: LyricsSoftware) {
  return invokeCommand<LyricsConfigView>("lyrics_tutorial_done", { software });
}

/** Pictures of slides (program indexes) as `data:` URLs; `null` where the
 * program gives none (Holyrics) or could not render one. */
export function getSlideThumbnails(presentationId: string, indexes: number[], cachedOnly = false) {
  return invokeCommand<Array<string | null>>("lyrics_slide_thumbnails", {
    presentationId,
    indexes,
    cachedOnly,
  });
}

/** Taps recorded in one section's editor, as steps of that exact marker. */
export function sectionStepsFromTaps(regionId: string, markerId: string, taps: number[]) {
  return invokeCommand<LyricsStep[]>("lyrics_section_steps_from_taps", { regionId, markerId, taps });
}

export function setLyricsRecording(regionId: string | null) {
  return invokeCommand<void>("lyrics_set_recording", { regionId });
}

export function getTapPosition() {
  return invokeCommand<number>("lyrics_tap_position");
}

export async function listenToLyricsStatus(handler: (status: LyricsStatus) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LyricsStatus>(LYRICS_STATUS_EVENT, (message) => handler(message.payload));
}

export async function listenToLyricsLinks(handler: (regionId: string) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>(LYRICS_LINK_EVENT, (message) => handler(message.payload));
}

/** A thrown command error as a `LyricsError` (Tauri rejects with the
 * serialized value, or a string for non-lyrics errors). */
export function asLyricsError(error: unknown): LyricsError {
  if (error && typeof error === "object" && "kind" in error) {
    return error as LyricsError;
  }
  return { kind: "unexpected", detail: String(error) };
}
