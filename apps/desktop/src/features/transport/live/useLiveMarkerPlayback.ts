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
    left.positionSeconds === right.positionSeconds &&
    left.activeGroupId === right.activeGroupId &&
    left.nextGroupId === right.nextGroupId &&
    left.currentRegionId === right.currentRegionId &&
    left.nextRegionId === right.nextRegionId &&
    left.secondsToNextGroup === right.secondsToNextGroup &&
    left.progressPercent === right.progressPercent
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
    const publish = () => {
      const sources = sourcesRef.current;
      const next = resolveLivePlaybackPosition(
        sources.groups,
        sources.regions,
        sources.positionSecondsRef.current,
      );
      setPosition((current) => (isSamePosition(current, next) ? current : next));
    };
    publish();
    const intervalId = window.setInterval(publish, LIVE_UI_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  return position ?? EMPTY_POSITION;
}
