/** Event-local musical intent. Screen coordinates alone become stale if the
 * camera moves between pointerdown and the long-press timeout. */
const positions = new WeakMap<Event, number>();
export function rememberTouchContextPosition(event: Event, seconds: number | undefined) {
  if (seconds !== undefined && Number.isFinite(seconds)) positions.set(event, seconds);
}
export function touchContextPosition(event: Event | { nativeEvent: Event }) {
  return positions.get("nativeEvent" in event ? event.nativeEvent : event);
}
