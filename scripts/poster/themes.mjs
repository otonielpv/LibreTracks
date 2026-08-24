// Visual themes for the release poster.
//
// The point of this file is that no two releases look the same. `pickTheme()`
// derives a theme from the version string, so v1.10.1 and v1.11.0 get different
// layouts and palettes without anyone having to choose. Pass --theme=<id> to
// override when a release deserves a specific look.
//
// A theme controls three things: the palette (accent + background), the layout
// (where the screenshot sits relative to the headline), and the decorative
// motif drawn behind everything.

export const THEMES = [
  {
    id: 'spotlight',
    // Classic: headline top-left, wide screenshot below, feature strip at the
    // bottom. This is the v1.9.0 look, kept as the baseline.
    layout: 'spotlight',
    accent: '#2dd4bf',
    accentSoft: '#5eead4',
    bg: '#0a0f12',
    bgGlow: 'radial-gradient(120% 90% at 12% 0%, #10262b 0%, #0a0f12 55%)',
    motif: 'grid',
    headlineWeight: 800,
  },
  {
    id: 'stage',
    // Warm amber, headline centred over a large screenshot that bleeds off the
    // right edge. Reads like a stage light on the app.
    layout: 'bleed-right',
    accent: '#fbbf24',
    accentSoft: '#fcd34d',
    bg: '#120d08',
    bgGlow: 'radial-gradient(130% 100% at 85% 10%, #33220c 0%, #120d08 60%)',
    motif: 'rays',
    headlineWeight: 900,
  },
  {
    id: 'monitor',
    // Cool indigo, split layout: text column left, tall screenshot right.
    layout: 'split',
    accent: '#818cf8',
    accentSoft: '#a5b4fc',
    bg: '#0b0b16',
    bgGlow: 'radial-gradient(110% 90% at 50% 110%, #1c1b3a 0%, #0b0b16 60%)',
    motif: 'waveform',
    headlineWeight: 800,
  },
  {
    id: 'signal',
    // Magenta/violet, screenshot as a tilted card with the headline overlapping
    // it. The most graphic of the set.
    layout: 'tilt',
    accent: '#f472b6',
    accentSoft: '#f9a8d4',
    bg: '#100a14',
    bgGlow: 'radial-gradient(120% 100% at 20% 100%, #2b1030 0%, #100a14 58%)',
    motif: 'dots',
    headlineWeight: 900,
  },
  {
    id: 'showcase',
    // Cyan on deep navy, the screenshot repeated as a device family: the
    // desktop shot large with a tablet and a phone stacked in front of it.
    // For releases whose headline is the same feature on every screen size.
    layout: 'devices',
    accent: '#22d3ee',
    accentSoft: '#67e8f9',
    bg: '#050b14',
    bgGlow: 'radial-gradient(120% 95% at 50% -10%, #0b2a3d 0%, #050b14 62%)',
    motif: 'stagelight',
    headlineWeight: 900,
  },
  {
    id: 'console',
    // Green-on-near-black, feature list as a numbered column beside a framed
    // screenshot. Technical, understated.
    layout: 'list',
    accent: '#4ade80',
    accentSoft: '#86efac',
    bg: '#08110c',
    bgGlow: 'radial-gradient(120% 90% at 100% 0%, #0d2618 0%, #08110c 55%)',
    motif: 'grid',
    headlineWeight: 700,
  },
];

/**
 * Deterministically map a version to a theme, so re-running the generator for
 * the same release reproduces the same poster, while consecutive releases
 * differ.
 *
 * Each version component is weighted before hashing. A plain digit sum collides
 * on pairs like 1.10.1 and 1.11.0 (both sum to 12), which would ship two
 * releases in a row with the same look — the one thing this is meant to avoid.
 */
export function pickTheme(version, override) {
  if (override) {
    const found = THEMES.find((t) => t.id === override);
    if (!found) {
      throw new Error(
        `Unknown theme "${override}". Available: ${THEMES.map((t) => t.id).join(', ')}`,
      );
    }
    return found;
  }
  const [major = 0, minor = 0, patch = 0] = version
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  // Coprime-ish weights keep neighbouring versions on different themes.
  const key = major * 7 + minor * 3 + patch * 1;
  return THEMES[key % THEMES.length];
}
