export type PopoverAnchor = {
  top: number;
  left: number;
  maxHeight: number;
  placement: "above" | "below";
};

const POPOVER_MARGIN = 12;
const POPOVER_GAP = 6;
const MIN_USABLE_HEIGHT = 160;

export function calculatePopoverAnchor(
  rect: Pick<DOMRect, "top" | "bottom" | "left">,
  panelWidth: number,
  panelHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  // Bottom safe-area inset (the iPhone home indicator). Without it a tall
  // panel ran down to the very edge and its last rows sat where a swipe
  // belongs to the system, not to the panel's scroll.
  safeAreaBottom = 0,
): PopoverAnchor {
  const width = Math.max(1, panelWidth);
  const height = Math.max(MIN_USABLE_HEIGHT, panelHeight);
  const spaceBelow = Math.max(
    0,
    viewportHeight - Math.max(0, safeAreaBottom) - rect.bottom - POPOVER_MARGIN,
  );
  const spaceAbove = Math.max(0, rect.top - POPOVER_MARGIN);
  const placement =
    spaceBelow < Math.min(height, 240) && spaceAbove > spaceBelow
      ? "above"
      : "below";
  const availableHeight = Math.max(
    MIN_USABLE_HEIGHT,
    (placement === "above" ? spaceAbove : spaceBelow) - POPOVER_GAP,
  );
  const visibleHeight = Math.min(height, availableHeight);
  const maxLeft = viewportWidth - width - POPOVER_MARGIN;

  return {
    top:
      placement === "above"
        ? Math.max(POPOVER_MARGIN, rect.top - POPOVER_GAP - visibleHeight)
        : rect.bottom + POPOVER_GAP,
    left: Math.max(POPOVER_MARGIN, Math.min(rect.left, maxLeft)),
    maxHeight: availableHeight,
    placement,
  };
}

/**
 * The bottom safe-area inset in CSS pixels, measured with a probe element.
 * Reading `--lt-safe-area-bottom` with getComputedStyle does not work: a
 * custom property comes back as its unresolved `env(...)` text.
 */
export function measureSafeAreaBottom(): number {
  if (typeof document === "undefined" || !document.body) return 0;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;bottom:0;width:0;visibility:hidden;pointer-events:none;" +
    "height:env(safe-area-inset-bottom, 0px)";
  document.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(height) ? height : 0;
}
