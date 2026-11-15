import { useEffect, useRef, useState } from "react";

import { advancePlayHistory, type PlayHistory } from "@libretracks/shared/charts/chartSync";

/** How long a jump that vanished from the snapshot without the playhead
 * reaching its target is still waited for (the engine already jumped and the
 * position is on its way), before it counts as cancelled. */
export const JUMP_LANDING_GRACE_MS = 1000;

type JumpState = {
  target: string;
  /** The part playing when the jump was scheduled. */
  from: string | null;
  landed: boolean;
  /** When the snapshot stopped reporting it (null while it does). */
  clearedAt: number | null;
};

type State = {
  regionId: string | null;
  history: PlayHistory;
  jump: JumpState | null;
  /** Where the playhead was last time, to see it go back inside a part. */
  last: { markerId: string | null; line: number | null };
};

/**
 * What has played in this song, in the order it played, for the lyrics
 * (`buildPerformanceBlocks`), plus the jump to preview below the part playing.
 *
 * The lyrics only ever go down, and a jump must not leave a trace that did
 * not play. Two things got in the way:
 *
 * - The visual clock runs free until the engine's next snapshot, so at a jump
 *   it plays on a few hundred ms into the part AFTER the current one (which
 *   never sounds). While a jump is scheduled, any part other than its target
 *   is ignored.
 * - The snapshot can drop the pending jump a tick before the playhead lands.
 *   The target keeps being previewed for `JUMP_LANDING_GRACE_MS`.
 *
 * When the jump lands its target is played again below, even when it is the
 * part already playing (a repeated chorus): reading never goes back up. The
 * same when the playhead goes back inside the part playing (a vamp looping,
 * a seek back): the part plays again below instead of scrolling up to it.
 */
export function usePerformanceHistory(
  regionId: string | null,
  markerId: string | null,
  /** The line playing by time (not the recording taps). */
  line: number | null,
  pendingMarkerId: string | null,
): { history: PlayHistory; pendingMarkerId: string | null } {
  const stateRef = useRef<State>({ regionId, history: [], jump: null, last: { markerId: null, line: null } });
  // Re-renders once when a vanished jump's grace runs out.
  const [, setTick] = useState(0);

  const state = stateRef.current;
  if (state.regionId !== regionId) {
    state.regionId = regionId;
    state.history = [];
    state.jump = null;
    state.last = { markerId: null, line: null };
  }

  if (pendingMarkerId !== null) {
    if (!state.jump || state.jump.target !== pendingMarkerId) {
      state.jump = { target: pendingMarkerId, from: markerId, landed: false, clearedAt: null };
    } else {
      state.jump.clearedAt = null;
    }
  } else if (state.jump && state.jump.clearedAt === null) {
    state.jump.clearedAt = Date.now();
  }

  const jump = state.jump;
  if (jump) {
    // A jump to another part lands when the playhead reaches it; a jump to
    // the part playing (vamp, repeat) only when the snapshot says it is done.
    const reached =
      markerId === jump.target && (jump.target !== jump.from || pendingMarkerId === null);
    if (!jump.landed && reached) {
      state.history = advancePlayHistory(state.history, jump.target, true);
      jump.landed = true;
    } else if (!jump.landed && markerId === jump.from) {
      // The part the jump leaves from still counts (a view opened with a jump
      // already scheduled); only the ones the clock overshoots into do not.
      state.history = advancePlayHistory(state.history, markerId);
    }
    const expired =
      jump.clearedAt !== null && Date.now() - jump.clearedAt >= JUMP_LANDING_GRACE_MS;
    if (pendingMarkerId === null && (jump.landed || expired)) {
      state.jump = null;
      // A cancelled jump: whatever plays now is real again.
      if (!jump.landed) state.history = advancePlayHistory(state.history, markerId);
    }
  } else {
    const back =
      markerId !== null &&
      markerId === state.last.markerId &&
      line !== null &&
      state.last.line !== null &&
      line < state.last.line;
    state.history = advancePlayHistory(state.history, markerId, back);
  }
  state.last = { markerId, line };

  const waiting = state.jump !== null && !state.jump.landed && state.jump.clearedAt !== null;
  useEffect(() => {
    if (!waiting) return;
    const id = window.setTimeout(() => setTick((tick) => tick + 1), JUMP_LANDING_GRACE_MS + 20);
    return () => window.clearTimeout(id);
  }, [waiting]);

  return {
    history: state.history,
    pendingMarkerId: state.jump && !state.jump.landed ? state.jump.target : null,
  };
}
