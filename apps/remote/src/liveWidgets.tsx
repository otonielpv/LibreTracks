import { memo, useEffect, useRef, useState } from "react";

import {
  buildSongTempoRegions,
  getSongBaseBpm,
  getSongBaseTimeSignature,
  markerColor,
  markerKindCategory,
  regionEffectiveKey,
  type SongRegionSummary,
  type SongView,
  type TransportSnapshot,
} from "@libretracks/shared/models";
import { getCumulativeMusicalPosition } from "@libretracks/shared/timelineMath";
import type { CSSProperties } from "react";

import { getRemoteStrings } from "./i18n";

const STRINGS = getRemoteStrings();

// Live widgets recompute their derived context off the same rAF-driven live
// position the transport readout uses, but they only re-render React when a
// human-visible value actually changes (a name, a rounded second, a whole
// bar). This keeps a stack of countdowns/progress bars cheap on stage tablets.
const WIDGET_MIN_UPDATE_INTERVAL_MS = 1000 / 15;

/** Section markers only — dynamic cues are spoken, not navigation targets. */
function sectionMarkersOf(songView: SongView | null) {
  return (songView?.sectionMarkers ?? []).filter(
    (marker) => markerKindCategory(marker.kind) === "section",
  );
}

function resolveLivePosition(snapshot: TransportSnapshot | null, receivedAtMs: number) {
  if (!snapshot) {
    return 0;
  }
  const transportClock = snapshot.transportClock;
  if (snapshot.playbackState === "playing") {
    const playbackRate =
      Number.isFinite(transportClock?.playbackRate) && transportClock?.playbackRate !== undefined
        ? Math.max(0, transportClock.playbackRate)
        : 1;
    const anchorPositionSeconds = transportClock?.running
      ? transportClock.anchorPositionSeconds
      : snapshot.positionSeconds;
    return Math.max(
      0,
      anchorPositionSeconds +
        ((performance.now() - receivedAtMs) / 1000) * playbackRate,
    );
  }
  return Math.max(0, snapshot.positionSeconds);
}

function formatClock(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The musical context around the live playhead, derived once per frame and
 * published to React only when a rounded/visible value changes. Every live
 * widget reads a slice of this so the derivation runs once, not per widget.
 */
export type LiveMusicalContext = {
  /** Region the playhead is inside, or null between/outside songs. */
  currentRegion: SongRegionSummary | null;
  /** The next region that starts after the playhead, or null if last. */
  nextRegion: SongRegionSummary | null;
  /** Name of the next section marker ahead of the playhead. */
  nextMarkerName: string | null;
  nextMarkerColor: string | null;
  /** Seconds remaining until the next section marker (null if none ahead). */
  secondsToMarker: number | null;
  /** Whole bars remaining until the next section marker (null if none). */
  barsToMarker: number | null;
  /** Seconds remaining until the next region starts (null if last/none). */
  secondsToSong: number | null;
  barsToSong: number | null;
  /** Effective key of the current region (transpose applied), or null. */
  currentKey: string | null;
};

const EMPTY_CONTEXT: LiveMusicalContext = {
  currentRegion: null,
  nextRegion: null,
  nextMarkerName: null,
  nextMarkerColor: null,
  secondsToMarker: null,
  barsToMarker: null,
  secondsToSong: null,
  barsToSong: null,
  currentKey: null,
};

type ContextSources = {
  snapshot: TransportSnapshot | null;
  songView: SongView | null;
  snapshotReceivedAtMs: number;
};

/**
 * Pure derivation of {@link LiveMusicalContext} from a song view and an
 * absolute playhead position. Extracted from the rAF loop so the (non-trivial)
 * "next marker / bars remaining / progress ratio" logic can be unit-tested
 * without timers. Bars remaining walk the song's tempo map so odd meters and
 * tempo changes are honoured.
 */
export function deriveLiveMusicalContext(
  songView: SongView | null,
  position: number,
): LiveMusicalContext {
  const regions = songView?.regions ?? [];
  const markers = sectionMarkersOf(songView);
  const tempoRegions = buildSongTempoRegions(songView);
  const baseBpm = getSongBaseBpm(songView);
  const baseSignature = getSongBaseTimeSignature(songView);

  const currentRegion =
    regions.find(
      (region) => position >= region.startSeconds && position < region.endSeconds,
    ) ?? null;

  const nextRegion =
    regions.find((region) => region.startSeconds > position + 0.001) ?? null;

  const nextMarker =
    markers.find((marker) => marker.startSeconds > position + 0.001) ?? null;

  const secondsToMarker = nextMarker
    ? Math.max(0, nextMarker.startSeconds - position)
    : null;
  const secondsToSong = nextRegion
    ? Math.max(0, nextRegion.startSeconds - position)
    : null;

  const currentBar = getCumulativeMusicalPosition(
    position,
    tempoRegions,
    baseBpm,
    baseSignature,
  ).barNumber;
  const barsToMarker = nextMarker
    ? Math.max(
        0,
        getCumulativeMusicalPosition(
          nextMarker.startSeconds,
          tempoRegions,
          baseBpm,
          baseSignature,
        ).barNumber - currentBar,
      )
    : null;
  const barsToSong = nextRegion
    ? Math.max(
        0,
        getCumulativeMusicalPosition(
          nextRegion.startSeconds,
          tempoRegions,
          baseBpm,
          baseSignature,
        ).barNumber - currentBar,
      )
    : null;

  return {
    currentRegion,
    nextRegion,
    nextMarkerName: nextMarker?.name ?? null,
    nextMarkerColor: nextMarker ? markerColor(nextMarker) : null,
    secondsToMarker,
    barsToMarker,
    secondsToSong,
    barsToSong,
    currentKey: regionEffectiveKey(currentRegion),
  };
}

/**
 * Drives a rAF loop that derives {@link LiveMusicalContext} from the live
 * playback position. `getSources` is called each frame so the hook always
 * reads the freshest snapshot/songView without re-subscribing. State is
 * committed only when a displayed field changes, throttled to
 * {@link WIDGET_MIN_UPDATE_INTERVAL_MS}.
 */
export function useLiveMusicalContext(
  getSources: () => ContextSources,
): LiveMusicalContext {
  const [context, setContext] = useState<LiveMusicalContext>(EMPTY_CONTEXT);
  const getSourcesRef = useRef(getSources);
  const lastCommitAtRef = useRef(0);

  useEffect(() => {
    getSourcesRef.current = getSources;
  }, [getSources]);

  useEffect(() => {
    let frameId = 0;

    const render = () => {
      const { snapshot, songView, snapshotReceivedAtMs } = getSourcesRef.current();
      const position = resolveLivePosition(snapshot, snapshotReceivedAtMs);
      const next = deriveLiveMusicalContext(songView, position);

      const now = performance.now();
      setContext((current) => {
        const intervalElapsed = now - lastCommitAtRef.current >= WIDGET_MIN_UPDATE_INTERVAL_MS;
        const changed =
          current.currentRegion?.id !== next.currentRegion?.id ||
          current.nextRegion?.id !== next.nextRegion?.id ||
          current.nextMarkerName !== next.nextMarkerName ||
          current.currentKey !== next.currentKey ||
          roundedSecond(current.secondsToMarker) !== roundedSecond(next.secondsToMarker) ||
          roundedSecond(current.secondsToSong) !== roundedSecond(next.secondsToSong) ||
          current.barsToMarker !== next.barsToMarker ||
          current.barsToSong !== next.barsToSong;

        if (!changed || !intervalElapsed) {
          return current;
        }
        lastCommitAtRef.current = now;
        return next;
      });

      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  return context;
}

function roundedSecond(value: number | null) {
  return value === null ? null : Math.round(value);
}

/** A single labelled tile — the shared shell every live widget renders into. */
function WidgetTile({
  label,
  children,
  tone,
  style,
}: {
  label: string;
  children: React.ReactNode;
  tone?: "marker" | "song" | "key";
  style?: CSSProperties;
}) {
  return (
    <div className={`live-widget live-widget-${tone ?? "plain"}`} style={style}>
      <span className="live-widget-label">{label}</span>
      <div className="live-widget-body">{children}</div>
    </div>
  );
}

export const NextMarkerWidget = memo(function NextMarkerWidget({
  context,
}: {
  context: LiveMusicalContext;
}) {
  return (
    <WidgetTile
      label={STRINGS.widgetNextMarker}
      tone="marker"
      style={
        context.nextMarkerColor
          ? ({ "--live-widget-accent": context.nextMarkerColor } as CSSProperties)
          : undefined
      }
    >
      <strong className="live-widget-name" title={context.nextMarkerName ?? undefined}>
        {context.nextMarkerName ?? STRINGS.widgetNone}
      </strong>
    </WidgetTile>
  );
});

export const NextSongWidget = memo(function NextSongWidget({
  context,
}: {
  context: LiveMusicalContext;
}) {
  return (
    <WidgetTile label={STRINGS.widgetNextSong} tone="song">
      <strong className="live-widget-name" title={context.nextRegion?.name ?? undefined}>
        {context.nextRegion?.name ?? STRINGS.widgetNone}
      </strong>
    </WidgetTile>
  );
});

export const CurrentKeyWidget = memo(function CurrentKeyWidget({
  context,
}: {
  context: LiveMusicalContext;
}) {
  return (
    <WidgetTile label={STRINGS.widgetKey} tone="key">
      <strong className="live-widget-key">{context.currentKey ?? "—"}</strong>
    </WidgetTile>
  );
});

function ProgressBar({ ratio }: { ratio: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div className="live-widget-progress" role="progressbar" aria-valuenow={Math.round(clamped * 100)}>
      <div className="live-widget-progress-fill" style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

export const ProgressToMarkerWidget = memo(function ProgressToMarkerWidget({
  context,
}: {
  context: LiveMusicalContext;
}) {
  // Progress within the current section = elapsed / span of the leg between the
  // current section start and the next marker. We only have "seconds remaining"
  // here, so use the region span as a stable denominator when available; else
  // fall back to a rolling 60s window so the bar still animates.
  const remaining = context.secondsToMarker;
  const ratio = progressRatioFromRemaining(remaining, context.currentRegion);
  return (
    <WidgetTile
      label={STRINGS.widgetProgressMarker}
      tone="marker"
      style={
        context.nextMarkerColor
          ? ({ "--live-widget-accent": context.nextMarkerColor } as CSSProperties)
          : undefined
      }
    >
      <ProgressBar ratio={ratio} />
      <span className="live-widget-sub">
        {remaining === null ? STRINGS.widgetNone : formatClock(remaining)}
      </span>
    </WidgetTile>
  );
});

export const ProgressToSongWidget = memo(function ProgressToSongWidget({
  context,
}: {
  context: LiveMusicalContext;
}) {
  const remaining = context.secondsToSong;
  const ratio = progressRatioFromRemaining(remaining, context.currentRegion);
  return (
    <WidgetTile label={STRINGS.widgetProgressSong} tone="song">
      <ProgressBar ratio={ratio} />
      <span className="live-widget-sub">
        {remaining === null ? STRINGS.widgetNone : formatClock(remaining)}
      </span>
    </WidgetTile>
  );
});

/**
 * Ratio filled for a "time until X" progress bar. When we know the current
 * region span we normalise remaining against it (so the bar reads how far
 * through the song we are toward the target); otherwise a rolling 60s window
 * keeps the bar meaningful.
 */
function progressRatioFromRemaining(
  remaining: number | null,
  region: SongRegionSummary | null,
) {
  if (remaining === null) {
    return 0;
  }
  const span =
    region && region.endSeconds > region.startSeconds
      ? region.endSeconds - region.startSeconds
      : 60;
  return 1 - Math.max(0, Math.min(1, remaining / span));
}

export type CountdownTarget = "marker" | "song";
export type CountdownUnit = "seconds" | "bars";

export const CountdownWidget = memo(function CountdownWidget({
  context,
  target,
  unit,
}: {
  context: LiveMusicalContext;
  target: CountdownTarget;
  unit: CountdownUnit;
}) {
  const seconds = target === "marker" ? context.secondsToMarker : context.secondsToSong;
  const bars = target === "marker" ? context.barsToMarker : context.barsToSong;
  const label =
    target === "marker" ? STRINGS.widgetCountdownMarker : STRINGS.widgetCountdownSong;

  let display: string;
  let sub: string;
  if (unit === "bars") {
    display = bars === null ? "—" : String(bars);
    sub = STRINGS.bars.toLowerCase();
  } else {
    display = seconds === null ? "—" : formatClock(seconds);
    sub = STRINGS.time.toLowerCase();
  }

  return (
    <WidgetTile
      label={label}
      tone={target === "marker" ? "marker" : "song"}
      style={
        target === "marker" && context.nextMarkerColor
          ? ({ "--live-widget-accent": context.nextMarkerColor } as CSSProperties)
          : undefined
      }
    >
      <strong className="live-widget-countdown">{display}</strong>
      <span className="live-widget-sub">{sub}</span>
    </WidgetTile>
  );
});
