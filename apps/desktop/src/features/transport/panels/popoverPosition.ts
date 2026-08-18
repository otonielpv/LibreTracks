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
): PopoverAnchor {
  const width = Math.max(1, panelWidth);
  const height = Math.max(MIN_USABLE_HEIGHT, panelHeight);
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - POPOVER_MARGIN);
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
