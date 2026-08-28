/**
 * Serializes a stream of "the newest value wins" backend calls.
 *
 * The shape shows up everywhere the UI streams a control's value to Rust while
 * the user is still moving it: a timeline seek, a fader drag, a settings
 * slider. Firing one invoke per event assumes they are cheap and ordered, and
 * neither is true. They take the session lock or the engine lock, so they can
 * queue behind something slow; and Tauri runs `(async)` commands on a
 * threadpool, so two in flight at once can be applied out of order and leave
 * the engine on a stale value.
 *
 * So: while a call is in flight, later values do not queue — they *replace* a
 * single pending value. When the in-flight call resolves, the pending value (if
 * it is still different) runs, and so on until the user stops moving.
 *
 * Optimistic UI is deliberately NOT handled here. Callers paint every event
 * immediately, so the control follows the pointer even for the values whose
 * backend call is dropped.
 */
export type LatestWinsStream<T> = (value: T) => Promise<void>;

export function createLatestWinsStream<T>(
  run: (value: T) => Promise<unknown>,
  isSame: (a: T, b: T) => boolean = Object.is,
): LatestWinsStream<T> {
  let inFlight = false;
  let hasPending = false;
  let pending: T | undefined;

  return async function push(value: T) {
    if (inFlight) {
      // Resolving right away is intentional: callers await this only to
      // sequence their own UI work, and the awaited value is now the one that
      // will actually reach the backend.
      pending = value;
      hasPending = true;
      return;
    }

    inFlight = true;
    try {
      let current = value;
      for (;;) {
        await run(current);
        if (!hasPending) return;
        const next = pending as T;
        hasPending = false;
        pending = undefined;
        // Nothing left to do when the newest value is the one just applied.
        if (isSame(next, current)) return;
        current = next;
      }
    } finally {
      inFlight = false;
      // On failure the caller reconciles from the confirmed state, so a value
      // queued behind the failed call would fight that reconciliation.
      hasPending = false;
      pending = undefined;
    }
  };
}

/**
 * One `createLatestWinsStream` per key, created on demand.
 *
 * For controls that exist once per object rather than once per app — a master
 * gain per song region, say. Two different regions must not serialize against
 * each other; two events for the SAME region must.
 */
export function createKeyedLatestWinsStreams<T>(
  run: (key: string, value: T) => Promise<unknown>,
  isSame?: (a: T, b: T) => boolean,
): (key: string, value: T) => Promise<void> {
  const streams = new Map<string, LatestWinsStream<T>>();
  return (key, value) => {
    let stream = streams.get(key);
    if (!stream) {
      stream = createLatestWinsStream<T>(
        (next) => run(key, next),
        isSame,
      );
      streams.set(key, stream);
    }
    return stream(value);
  };
}
