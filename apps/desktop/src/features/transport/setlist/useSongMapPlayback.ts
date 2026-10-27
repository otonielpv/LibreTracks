import { useEffect, useRef, useState, type RefObject } from "react";

import {
  cancelGatedFrame,
  markFrameActivity,
  requestGatedFrame,
  useFrameGateWake,
} from "../frameGate";
import { resolveActiveBlock, type SongMapBlock } from "./songMapModel";

export type SongMapPlayback = { activeId: string | null; nextId: string | null };

/**
 * Follows the mutable playhead for the song map. React only hears about it
 * when the ACTIVE or NEXT block changes; the progress inside the active block
 * is written straight to `fillRef` as a transform. Unlike Live's
 * useLiveMarkerPlayback there is no 100 ms clock: the map has no seconds
 * label to keep fresh, so a block costs zero renders while it plays.
 */
export function useSongMapPlayback(
  blocks: readonly SongMapBlock[],
  positionSecondsRef: { readonly current: number },
  fillRef: RefObject<HTMLElement | null>,
): SongMapPlayback {
  useFrameGateWake();
  const [state, setState] = useState<SongMapPlayback>(() => {
    const resolved = resolveActiveBlock(blocks, positionSecondsRef.current);
    return { activeId: resolved.activeId, nextId: resolved.nextId };
  });
  const sourcesRef = useRef({ blocks, positionSecondsRef, fillRef });
  sourcesRef.current = { blocks, positionSecondsRef, fillRef };

  useEffect(() => {
    let frameId = 0;
    let published = { activeId: state.activeId, nextId: state.nextId };
    let lastScale = -1;
    let lastElement: HTMLElement | null = null;
    const frame = () => {
      const sources = sourcesRef.current;
      const resolved = resolveActiveBlock(
        sources.blocks,
        sources.positionSecondsRef.current,
      );
      if (
        resolved.activeId !== published.activeId ||
        resolved.nextId !== published.nextId
      ) {
        published = { activeId: resolved.activeId, nextId: resolved.nextId };
        setState(published);
        markFrameActivity();
      }
      const element = sources.fillRef.current;
      if (element !== lastElement || resolved.progress !== lastScale) {
        element?.style.setProperty("transform", `scaleX(${resolved.progress})`);
        lastElement = element;
        lastScale = resolved.progress;
        markFrameActivity();
      }
      frameId = requestGatedFrame(frame);
    };
    frameId = requestGatedFrame(frame);
    return () => cancelGatedFrame(frameId);
    // Sources arrive through sourcesRef; the loop is installed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
