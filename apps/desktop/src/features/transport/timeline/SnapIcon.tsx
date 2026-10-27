/**
 * The snap-to-grid toggle's glyph: a horseshoe magnet, slashed when snap is
 * off. Shared by the DAW toolbar and the Setlist editors so the toggle reads
 * the same everywhere.
 *
 * Drawn as inline SVG: Material Symbols' `magnet` names aren't in this build.
 * Two thick parallel arms joined by a wide rounded curve, with the pole tips
 * at the top; this reads as a magnet at small sizes much better than the
 * earlier U-with-tick-marks attempt. The slash makes the state unmistakable
 * without relying on colour.
 */
export function SnapIcon({ enabled, size = 18 }: { enabled: boolean; size?: number }) {
  return (
    <svg
      className="lt-snap-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Arms, bottom curve, pole tips (so it reads as a magnet, not a tuning fork). */}
      <line x1="5.5" y1="4" x2="5.5" y2="13" />
      <line x1="18.5" y1="4" x2="18.5" y2="13" />
      <path d="M5.5 13a6.5 6.5 0 0 0 13 0" />
      <line x1="3" y1="4" x2="8" y2="4" />
      <line x1="16" y1="4" x2="21" y2="4" />
      {!enabled ? <line x1="4" y1="20" x2="20" y2="4" /> : null}
    </svg>
  );
}
