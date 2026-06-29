import type { MarkerKind } from "@libretracks/shared/models";

/** Ordered list of section kinds as shown in the marker "Type" submenu. The
 * order follows a typical song's arc (intro → outro) with Custom last. This is
 * the single source of truth for the kind vocabulary on the frontend; it mirrors
 * the Rust `MarkerKind` enum. */
export const MARKER_KINDS: readonly MarkerKind[] = [
  "intro",
  "verse",
  "pre_chorus",
  "chorus",
  "post_chorus",
  "bridge",
  "breakdown",
  "drop",
  "solo",
  "outro",
  "acapella",
  "instrumental",
  "interlude",
  "refrain",
  "tag",
  "vamp",
  "ending",
  "exhortation",
  "rap",
  "turnaround",
  "custom",
] as const;

/** Dynamic guide cues: one-shot spoken instructions that happen *within* a
 * section (not a section themselves), e.g. "Build", "All In", "Drums In". Shown
 * in a separate group from the section kinds in the marker "Type" menu. The
 * order roughly groups instruments / dynamics / structure for readability. */
export const CUE_KINDS: readonly MarkerKind[] = [
  "build",
  "slowly_build",
  "all_in",
  "drums_in",
  "break",
  "hold",
  "softly",
  "swell",
  "hits",
  "last_time",
  "big_ending",
  "key_change_up",
  "key_change_down",
  "drums",
  "bass",
  "guitar",
  "keys",
  "ad_lib",
  "worship_freely",
] as const;

const CUE_KIND_SET: ReadonlySet<MarkerKind> = new Set(CUE_KINDS);

/** Whether a kind is a dynamic cue or a song section. Derived from the kind
 * (mirrors Rust `MarkerKind::category`); drives the marker menu grouping and
 * the voice-guide behaviour. `custom` is treated as a section. */
export function markerKindCategory(
  kind: MarkerKind | undefined,
): "section" | "cue" {
  return kind && CUE_KIND_SET.has(kind) ? "cue" : "section";
}

/** Resting-state colour for a marker of each kind, used when the marker is not
 * armed/selected/current (those states keep their own meaningful colours). The
 * palette is chosen so adjacent song sections read as distinct at a glance.
 * `custom` deliberately matches the previous generic marker grey so untyped
 * markers look exactly as they did before. */
const MARKER_KIND_COLORS: Record<MarkerKind, string> = {
  intro: "#8ea3b0",
  verse: "#5aa9e6",
  pre_chorus: "#7ec4cf",
  chorus: "#f6a14c",
  post_chorus: "#f4c95d",
  bridge: "#b08be0",
  breakdown: "#9b8cff",
  drop: "#e8607a",
  solo: "#e0d35a",
  outro: "#8ea3b0",
  acapella: "#d98fb0",
  instrumental: "#6fbf9b",
  interlude: "#88c0a8",
  refrain: "#6ec0d6",
  tag: "#c9a26b",
  vamp: "#a6c47e",
  ending: "#9aa0a8",
  exhortation: "#d4a05a",
  rap: "#c77dd4",
  turnaround: "#7fa8d0",
  custom: "#bacac5",
  // Cues share a warmer, desaturated accent family so they read as a distinct
  // class from the section colours above.
  build: "#e0894a",
  slowly_build: "#d98f5c",
  all_in: "#e07a4a",
  drums_in: "#d4924a",
  break: "#8a96a0",
  hold: "#9aa6b0",
  softly: "#9fb0bd",
  swell: "#c0a06a",
  hits: "#e06a6a",
  last_time: "#cf8a5a",
  big_ending: "#d9665a",
  key_change_up: "#6fbf9b",
  key_change_down: "#6fa8bf",
  drums: "#caa06a",
  bass: "#b0926a",
  guitar: "#c2a072",
  keys: "#b89a72",
  ad_lib: "#c79a8a",
  worship_freely: "#b89ad0",
};

/** English fallback labels, used when no translation function is supplied (or a
 * key is missing). The localized labels live under `transport.markerKind.<kind>`
 * in the i18n bundles. */
const MARKER_KIND_LABELS: Record<MarkerKind, string> = {
  intro: "Intro",
  verse: "Verse",
  pre_chorus: "Pre-Chorus",
  chorus: "Chorus",
  post_chorus: "Post-Chorus",
  bridge: "Bridge",
  breakdown: "Breakdown",
  drop: "Drop",
  solo: "Solo",
  outro: "Outro",
  acapella: "Acapella",
  instrumental: "Instrumental",
  interlude: "Interlude",
  refrain: "Refrain",
  tag: "Tag",
  vamp: "Vamp",
  ending: "Ending",
  exhortation: "Exhortation",
  rap: "Rap",
  turnaround: "Turnaround",
  custom: "Custom",
  build: "Build",
  slowly_build: "Slowly Build",
  all_in: "All In",
  drums_in: "Drums In",
  break: "Break",
  hold: "Hold",
  softly: "Softly",
  swell: "Swell",
  hits: "Hits",
  last_time: "Last Time",
  big_ending: "Big Ending",
  key_change_up: "Key Change Up",
  key_change_down: "Key Change Down",
  drums: "Drums",
  bass: "Bass",
  guitar: "Guitar",
  keys: "Keys",
  ad_lib: "Ad Lib",
  worship_freely: "Worship Freely",
};

/** Resting-state colour as an `rgb`/hex string. Falls back to the custom grey
 * for unknown values (e.g. a snapshot from a newer build). */
export function markerKindColor(kind: MarkerKind | undefined): string {
  return MARKER_KIND_COLORS[kind ?? "custom"] ?? MARKER_KIND_COLORS.custom;
}

/** Localized label for a kind. Pass the i18n `t` to translate; without it (or on
 * a missing key) the English fallback is returned. */
export function markerKindLabel(
  kind: MarkerKind | undefined,
  t?: (key: string, options?: { defaultValue?: string }) => string,
): string {
  const resolved = kind ?? "custom";
  const fallback = MARKER_KIND_LABELS[resolved] ?? MARKER_KIND_LABELS.custom;
  if (!t) return fallback;
  return t(`transport.markerKind.${resolved}`, { defaultValue: fallback });
}

/** Highest numbered variant shipped in the bundled voice pack, per kind. The
 * variant picker offers 1..N for these kinds and nothing for the rest, so the
 * UI never presents a variant that has no recording (e.g. there is no Verse 8).
 * Both bundled languages share the same coverage. */
const MARKER_KIND_MAX_VARIANT: Partial<Record<MarkerKind, number>> = {
  verse: 6,
  chorus: 4,
  bridge: 4,
  pre_chorus: 4,
};

/** Available numbered variants for a kind, e.g. [1,2,3,4] for chorus, [] when
 * the kind has no numbered recordings. */
export function markerKindVariants(kind: MarkerKind | undefined): number[] {
  const max = kind ? MARKER_KIND_MAX_VARIANT[kind] : undefined;
  if (!max) return [];
  return Array.from({ length: max }, (_, i) => i + 1);
}
