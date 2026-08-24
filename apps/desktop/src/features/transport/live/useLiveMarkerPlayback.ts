import { useEffect, useRef, useState } from "react";

import type { SongRegionSummary } from "@libretracks/shared/models";
import {
  resolveLivePlaybackPosition,
  type LiveMarkerGroup,
  type LivePlaybackPosition,
} from "./liveMarkerModel";

const LIVE_UI_POLL_MS = 100;
const EMPTY_POSITION: LivePlaybackPosition = {
  positionSeconds: 0,
  activeGroupId: null,
  nextGroupId: null,
  currentRegionId: null,
  nextRegionId: null,
  secondsToNextGroup: null,
  progressPercent: 0,
};

function isSamePosition(
  left: LivePlaybackPosition,
  right: LivePlaybackPosition,
) {
  return (
    Math.floor(left.positionSeconds) === Math.floor(right.positionSeconds) &&
    left.activeGroupId === right.activeGroupId &&
    left.nextGroupId === right.nextGroupId &&
    left.currentRegionId === right.currentRegionId &&
    left.nextRegionId === right.nextRegionId &&
    left.secondsToNextGroup === right.secondsToNextGroup &&
    left.progressPercent === right.progressPercent
  );
}

function isSamePlaybackStructure(
  left: LivePlaybackPosition,
  right: LivePlaybackPosition,
) {
  return (
    left.activeGroupId === right.activeGroupId &&
    left.nextGroupId === right.nextGroupId &&
    left.currentRegionId === right.currentRegionId &&
    left.nextRegionId === right.nextRegionId
  );
}

/**
 * Reads the parent's mutable playhead without subscribing React to 60fps.
 * At most a visible second, percentage, marker, or song change is published.
 */
export function useLiveMarkerPlayback(
  groups: readonly LiveMarkerGroup[],
  regions: readonly SongRegionSummary[],
  positionSecondsRef: { readonly current: number },
) {
  const [position, setPosition] = useState<LivePlaybackPosition>(() =>
    resolveLivePlaybackPosition(groups, regions, positionSecondsRef.current),
  );
  const sourcesRef = useRef({ groups, regions, positionSecondsRef });
  sourcesRef.current = { groups, regions, positionSecondsRef };

  useEffect(() => {
    let frameId = 0;
    let lastResolved = position;
    const resolveCurrent = () => {
      const sources = sourcesRef.current;
      return resolveLivePlaybackPosition(
        sources.groups,
        sources.regions,
        sources.positionSecondsRef.current,
      );
    };
    const publishClock = () => {
      const next = resolveCurrent();
      lastResolved = next;
      setPosition((current) => (isSamePosition(current, next) ? current : next));
    };
    const followStructure = () => {
      const next = resolveCurrent();
      if (!isSamePlaybackStructure(lastResolved, next)) {
        lastResolved = next;
        setPosition(next);
      }
      frameId = window.requestAnimationFrame(followStructure);
    };

    publishClock();
    frameId = window.requestAnimationFrame(followStructure);
    const intervalId = window.setInterval(publishClock, LIVE_UI_POLL_MS);
    return () => {
      window.clearInterval(intervalId);
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  return position ?? EMPTY_POSITION;
}
