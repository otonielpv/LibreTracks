type LeadTailProps = {
  anchorSeconds: number;
  /** Where the item really fires (plan lead-time); nothing drawn when absent. */
  leadStartSeconds?: number | null;
  pxPerSecond: number;
};

/**
 * Dashed tail from an item's anchor back to where its lead makes it fire.
 * Rendered inside the item, so it moves with it while dragging.
 */
export function LeadTail({ anchorSeconds, leadStartSeconds, pxPerSecond }: LeadTailProps) {
  if (leadStartSeconds == null || !Number.isFinite(leadStartSeconds)) return null;
  const widthPx = (anchorSeconds - leadStartSeconds) * pxPerSecond;
  if (!(widthPx > 1)) return null;
  return <span className="lt-setlist-lead-tail" aria-hidden="true" style={{ width: `${widthPx}px` }} />;
}
