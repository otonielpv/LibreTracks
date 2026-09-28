import type { ExternalDropKind } from "../library/dragDrop";

/**
 * Colours and text of the guide line and badge shown while files are dragged
 * over the timeline. Records keyed by ExternalDropKind, so a new kind must be
 * given its look here instead of silently falling through to the red
 * "Unsupported" (which is what happened to "video").
 */
type Rgb = `${number},${number},${number}`;

const GREEN: Rgb = "122,229,130";
const ORANGE: Rgb = "255,184,107";
const BLUE: Rgb = "118,184,255";
const RED: Rgb = "255,107,107";

const SOLID: Record<Rgb, string> = {
  [GREEN]: "#7ae582",
  [ORANGE]: "#ffb86b",
  [BLUE]: "#76b8ff",
  [RED]: "#ff6b6b",
};

/** Videos land as clips like audio, so they share its accepted green. */
const GUIDE: Record<ExternalDropKind, Rgb> = {
  audio: GREEN,
  video: GREEN,
  package: ORANGE,
  external: RED,
  unknown: BLUE,
  mixed: RED,
  unsupported: RED,
};

const BADGE: Record<ExternalDropKind, Rgb> = { ...GUIDE, external: ORANGE };

export const EXTERNAL_DROP_LABELS: Record<ExternalDropKind, string> = {
  audio: "Audio",
  video: "Video",
  package: "Package",
  external: "Reaper/Ableton",
  unknown: "Drop",
  mixed: "Mixed",
  unsupported: "Unsupported",
};

export function externalDropGuideColors(kind: ExternalDropKind) {
  const rgb = GUIDE[kind];
  const ring = rgb === GREEN ? 0.24 : 0.22;
  const glow = rgb === GREEN ? 0.44 : 0.42;
  return {
    background: SOLID[rgb],
    boxShadow: `0 0 0 1px rgba(${rgb},${ring}), 0 0 18px rgba(${rgb},${glow})`,
  };
}

export function externalDropBadgeColors(kind: ExternalDropKind) {
  const rgb = BADGE[kind];
  return {
    background: `rgba(${rgb},${rgb === BLUE ? 0.16 : 0.18})`,
    border: `1px solid rgba(${rgb},0.34)`,
  };
}
