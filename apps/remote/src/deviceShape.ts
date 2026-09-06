/** Screen geometry in CSS pixels, as the device family classifier sees it. */
export type ScreenSize = { width: number; height: number };

/** True only for phone-shaped screens.
 *
 * The rotate guard used to key off the viewport height alone (`max-height:
 * 500px` in landscape), which misfires on tablets: a 1200x2000 11" tablet
 * reported by Android at devicePixelRatio 2.25 is 533 CSS px tall in landscape,
 * and the browser's address bar pushes that under 500. Screen short side plus
 * aspect ratio describes the physical family instead: phones are narrow *and*
 * elongated (16:9 or taller), while tablets are 4:3 / 3:2 / 16:10 and much
 * wider. Ambiguous devices fall on the permissive side and keep landscape. */
export function isPhoneShapedScreen({ width, height }: ScreenSize): boolean {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (!Number.isFinite(shortSide) || shortSide <= 0) {
    return false;
  }
  return shortSide <= 480 && longSide / shortSide >= 1.7;
}

/** Physical screen geometry, which -- unlike the viewport -- is not shrunk by
 * the browser's own chrome (address bar, navigation bar). */
export function currentScreenSize(): ScreenSize {
  return {
    width: window.screen?.width || window.innerWidth,
    height: window.screen?.height || window.innerHeight,
  };
}
