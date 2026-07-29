import type { MarkerKind } from "@libretracks/shared/models";
import {
  CUE_KINDS,
  markerCategory,
  markerColor,
  markerKindCategory,
  markerKindColor,
} from "@libretracks/shared/models";

// Re-export the shared cue vocabulary + colour helpers so existing desktop call
// sites keep importing these from "./markerKinds". The single source of truth
// lives in the shared package (the remote consumes it too).
export {
  CUE_KINDS,
  markerCategory,
  markerColor,
  markerKindCategory,
  markerKindColor,
};

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
  "next_song",
  "custom",
] as const;



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
  get_ready: "Get Ready",
  ease_down: "Ease Down",
  next_song: "Next Song",
};


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

/** Cue kinds that have NO voice recording in a given language, so creating one
 * would produce a silent marker. The bundled pack doesn't cover the same cues
 * in every language; hide those from the create/change menus for that language.
 * Keyed by the voice-guide language code (see resources/voices/<lang>/cues). */
const CUE_KINDS_WITHOUT_RECORDING: Record<string, readonly MarkerKind[]> = {
  // Both bundled languages now cover every cue.
  es: [],
  en: [],
};

/** Section kinds with no recording, in every language: the pack has never
 * shipped a clip for these, so they would announce as silence. Unlike the cue
 * list this is not per-language — add a language key here only if a section
 * exists in one language but not another. */
const SECTION_KINDS_WITHOUT_RECORDING: readonly MarkerKind[] = [
  // "Drop" is EDM vocabulary; the pack is worship/band and never recorded it.
  "drop",
];

/** Cue kinds that actually have a recording in the active voice-guide language,
 * in menu order. Falls back to the full list for unknown languages (better to
 * offer a maybe-silent cue than to hide everything). */
export function availableCueKinds(language: string): readonly MarkerKind[] {
  const missing = CUE_KINDS_WITHOUT_RECORDING[language];
  if (!missing || missing.length === 0) return CUE_KINDS;
  return CUE_KINDS.filter((kind) => !missing.includes(kind));
}

/** Section kinds that have a recording, in menu order. Mirrors
 * {@link availableCueKinds} for sections: without it the menu offers kinds the
 * pack never recorded, and the marker announces as silence. Custom is always
 * kept — it is an untyped marker with no clip by design.
 *
 * Takes no language: the uncovered sections are missing from every bundled
 * language. Give it a `language` parameter (like `availableCueKinds`) the day a
 * section ships in one language but not another. */
export function availableSectionKinds(): readonly MarkerKind[] {
  if (SECTION_KINDS_WITHOUT_RECORDING.length === 0) return MARKER_KINDS;
  return MARKER_KINDS.filter(
    (kind) => kind === "custom" || !SECTION_KINDS_WITHOUT_RECORDING.includes(kind),
  );
}
