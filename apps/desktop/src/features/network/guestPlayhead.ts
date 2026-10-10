import { useEffect, useRef } from "react";

import type { NetworkGuestTransport } from "@libretracks/shared/networkApi";
import type { SongView } from "@libretracks/shared/models";

/**
 * The host's playhead on a guest, at `nowUnixMs`.
 *
 * The backend already corrected the anchor for network delay and the clock
 * offset when it emitted (`anchorPositionSeconds` is the host position AT
 * `emittedAtUnixMs`), so from here it only advances at the playback rate,
 * exactly as the local transport does between its own snapshots.
 */
export function guestPositionAt(
  transport: NetworkGuestTransport | null,
  nowUnixMs: number,
): number {
  if (!transport) return 0;
  const { snapshot } = transport;
  const running =
    snapshot.playbackState === "playing" && Boolean(snapshot.transportClock?.running);
  if (!running) return transport.anchorPositionSeconds;
  const rate = snapshot.transportClock?.playbackRate ?? 1;
  const elapsed = Math.max(0, (nowUnixMs - transport.emittedAtUnixMs) / 1000);
  return transport.anchorPositionSeconds + elapsed * rate;
}

/** The song (region) playing at `positionSeconds`, or the first one. */
export function regionAt(song: SongView | null, positionSeconds: number) {
  if (!song) return null;
  const regions = [...song.regions].sort((a, b) => a.startSeconds - b.startSeconds);
  return (
    regions.find(
      (region) => positionSeconds >= region.startSeconds && positionSeconds < region.endSeconds,
    ) ??
    regions[0] ??
    null
  );
}

/**
 * A ref that follows the host's playhead every frame. Mutated without
 * `setState` on purpose, like the local playhead: the live view reads it from
 * its own animation frame (docs/REDESIGN_transport_refs_to_stores.md).
 */
export function useGuestPlayheadRef(transport: NetworkGuestTransport | null) {
  const positionRef = useRef(guestPositionAt(transport, Date.now()));
  const transportRef = useRef(transport);
  transportRef.current = transport;

  useEffect(() => {
    positionRef.current = guestPositionAt(transport, Date.now());
  }, [transport]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      positionRef.current = guestPositionAt(transportRef.current, Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return positionRef;
}
