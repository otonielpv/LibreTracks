import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  meterDbToDisplayScale,
  peakToMeterDb,
  stepMeterDb,
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_ACTIVE_EPSILON_DB,
  METER_MIN_DB,
} from "@libretracks/shared/meterBallistics";

import type { TrackSummary } from "./desktopApi";
import { useTransportStore, type OptimisticMixState } from "./store";

/**
 * Reusable horizontal-scroll mixer that lays out one vertical channel strip
 * per track. Lives in its own file (rather than nested inside CompactView)
 * so the DAW view can mount it too if we ever want a global mixer there.
 *
 * The mixer is presentational — it does not own track state. All mutations
 * happen via the callbacks passed in, the same way the DAW track header
 * dispatches them, so optimistic store updates stay consistent between
 * views.
 */

export type CompactMixerHandlers = {
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
  onToggleTranspose: (trackId: string) => void;
  onVolumeChange: (trackId: string, nextVolume: number) => void;
  onCommitVolume: (trackId: string) => void;
  onPanChange: (trackId: string, nextPan: number) => void;
  onCommitPan: (trackId: string) => void;
  onAudioToChange: (trackId: string, nextAudioTo: string) => void;
};

type CompactMixerProps = {
  tracks: TrackSummary[];
  audioRoutingOptions: Array<{ value: string; label: string }>;
  handlers: CompactMixerHandlers;
  /** Fire the same DAW track context menu when the user right-clicks a
   * strip. The parent owns the menu so the seven existing actions
   * (insert, rename, color, delete, indent, unindent, …) reuse one
   * implementation. */
  onTrackContextMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
};

/** Default colour applied to a track strip when track.color is null, the
 * way Reaper paints unset tracks with a neutral grey rather than leaving
 * them transparent. Folder tracks get a slightly different default so the
 * eye can still tell folder strips apart from leaf audio strips when no
 * user colour is configured anywhere in the project. */
const DEFAULT_TRACK_ACCENT = "rgba(186, 202, 197, 0.35)";
const DEFAULT_FOLDER_ACCENT = "rgba(87, 241, 219, 0.55)";

function CompactMixerComponent({
  tracks,
  audioRoutingOptions,
  handlers,
  onTrackContextMenu,
}: CompactMixerProps) {
  // Build a (childTrackId → parent colour / parent name) lookup once so each
  // strip can render its Reaper-style folder cue (a thin coloured ribbon on
  // the left edge + a tiny "↳ Parent" hint under the strip name) without
  // having to walk the project's track tree at render time.
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const parentInfoByTrackId = new Map<
    string,
    { color: string; name: string }
  >();
  for (const track of tracks) {
    if (!track.parentTrackId) continue;
    const parent = trackById.get(track.parentTrackId);
    if (!parent) continue;
    parentInfoByTrackId.set(track.id, {
      color: parent.color ?? DEFAULT_FOLDER_ACCENT,
      name: parent.name,
    });
  }

  return (
    <div className="lt-compact-mixer">
      <div className="lt-compact-mixer-strips">
        {tracks.map((track) => (
          <CompactMixerStrip
            key={track.id}
            track={track}
            audioRoutingOptions={audioRoutingOptions}
            handlers={handlers}
            parentInfo={parentInfoByTrackId.get(track.id) ?? null}
            onContextMenu={onTrackContextMenu}
          />
        ))}
      </div>
    </div>
  );
}

export const CompactMixer = memo(CompactMixerComponent);

type CompactMixerStripProps = {
  track: TrackSummary;
  audioRoutingOptions: Array<{ value: string; label: string }>;
  handlers: CompactMixerHandlers;
  parentInfo: { color: string; name: string } | null;
  onContextMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
};

// Snap thresholds: when the slider lands within this fraction of the
// snap target, the value pulls to the target. 3% of the slider range
// matches the "feels-magnetic" zone in Ableton and most other DAWs.
const VOLUME_SNAP_TARGET = 1.0;
const VOLUME_SNAP_RANGE = 1.0; // slider runs 0..1
const VOLUME_SNAP_THRESHOLD = VOLUME_SNAP_RANGE * 0.03;
const PAN_SNAP_TARGET = 0.0;
const PAN_SNAP_RANGE = 2.0; // slider runs -1..1
const PAN_SNAP_THRESHOLD = PAN_SNAP_RANGE * 0.03;

function applySnap(
  value: number,
  target: number,
  threshold: number,
  bypass: boolean,
): number {
  if (bypass) return value;
  return Math.abs(value - target) <= threshold ? target : value;
}

function CompactMixerStripComponent({
  track,
  audioRoutingOptions,
  handlers,
  parentInfo,
  onContextMenu,
}: CompactMixerStripProps) {
  const isFolder = track.kind === "folder";
  // Track accent (drives --track-accent CSS var). If the track has a user
  // colour use it; otherwise pick a neutral default that's visible but
  // doesn't compete for attention. Folder strips get a slightly bolder
  // default so they stand out from leaf tracks even before the user
  // colours anything.
  const trackAccent =
    track.color ?? (isFolder ? DEFAULT_FOLDER_ACCENT : DEFAULT_TRACK_ACCENT);
  // Mirror the DAW track header's optimistic-state pattern: while the user
  // drags the volume or pan slider the live value lives in the store; the
  // committed value lives on `track`. We read the optimistic value (if any)
  // and fall back to the persisted one so the slider tracks the pointer
  // with zero IPC delay.
  const optimisticMix = useTransportStore(
    (state) => state.optimisticMix[track.id] ?? null,
  );
  const muted = effectiveBool(optimisticMix?.muted, track.muted);
  const solo = effectiveBool(optimisticMix?.solo, track.solo);
  const volume = effectiveNumber(optimisticMix?.volume, track.volume);
  const pan = effectiveNumber(optimisticMix?.pan, track.pan);

  // Track Shift state via global key listeners so the slider's onChange
  // can read it without the event object: ChangeEvent doesn't carry
  // modifier flags. Pressing Shift while dragging temporarily disables
  // the snap so the user can adjust right across unity / centre.
  const shiftPressedRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftPressedRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftPressedRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const handleVolumeInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = Number(event.target.value);
      if (!Number.isFinite(next)) return;
      const snapped = applySnap(
        next,
        VOLUME_SNAP_TARGET,
        VOLUME_SNAP_THRESHOLD,
        shiftPressedRef.current,
      );
      handlers.onVolumeChange(track.id, snapped);
    },
    [handlers, track.id],
  );

  const handlePanInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = Number(event.target.value);
      if (!Number.isFinite(next)) return;
      const snapped = applySnap(
        next,
        PAN_SNAP_TARGET,
        PAN_SNAP_THRESHOLD,
        shiftPressedRef.current,
      );
      handlers.onPanChange(track.id, snapped);
    },
    [handlers, track.id],
  );

  // Double-click resets to the snap target — Ableton-style "reset to unity"
  // for the fader and "reset to centre" for the pan. After the reset we
  // also commit so the snapshot reflects the new value immediately rather
  // than waiting for the next pointer-up.
  const handleVolumeDoubleClick = useCallback(() => {
    handlers.onVolumeChange(track.id, VOLUME_SNAP_TARGET);
    handlers.onCommitVolume(track.id);
  }, [handlers, track.id]);

  const handlePanDoubleClick = useCallback(() => {
    handlers.onPanChange(track.id, PAN_SNAP_TARGET);
    handlers.onCommitPan(track.id);
  }, [handlers, track.id]);

  // Tooltip flag used to show the current pan value while the user drags
  // the slider, the way Ableton overlays the numeric value next to the
  // thumb. Set on pointerdown, cleared on pointerup/cancel.
  const [isPanDragging, setIsPanDragging] = useState(false);

  const handleAudioToChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      handlers.onAudioToChange(track.id, event.target.value);
    },
    [handlers, track.id],
  );

  return (
    <div
      className={`lt-compact-mixer-strip ${
        isFolder ? "is-folder" : ""
      } ${parentInfo ? "is-child" : ""}`}
      style={
        {
          ["--track-accent" as string]: trackAccent,
          ...(parentInfo
            ? { ["--parent-accent" as string]: parentInfo.color }
            : null),
        } as React.CSSProperties
      }
      onContextMenu={(event) => onContextMenu(event, track.id)}
    >
      <div className="lt-compact-mixer-strip-name" title={track.name}>
        {isFolder ? (
          <span
            className="lt-compact-mixer-folder-icon material-symbols-outlined"
            aria-hidden="true"
          >
            folder
          </span>
        ) : null}
        {track.name}
      </div>
      {parentInfo ? (
        <div
          className="lt-compact-mixer-strip-parent"
          title={`Dentro de ${parentInfo.name}`}
        >
          ↳ {parentInfo.name}
        </div>
      ) : null}

      <div className="lt-compact-mixer-strip-toggles">
        <button
          type="button"
          className={`lt-compact-mixer-toggle is-mute ${muted ? "is-on" : ""}`}
          aria-pressed={muted}
          aria-label={`Mute ${track.name}`}
          onClick={() => handlers.onToggleMute(track.id)}
        >
          M
        </button>
        <button
          type="button"
          className={`lt-compact-mixer-toggle is-solo ${solo ? "is-on" : ""}`}
          aria-pressed={solo}
          aria-label={`Solo ${track.name}`}
          onClick={() => handlers.onToggleSolo(track.id)}
        >
          S
        </button>
        <button
          type="button"
          className={`lt-compact-mixer-toggle is-transpose ${
            track.transposeEnabled ? "is-on" : ""
          }`}
          aria-pressed={track.transposeEnabled}
          aria-label={`Toggle transpose for ${track.name}`}
          onClick={() => handlers.onToggleTranspose(track.id)}
          title="Sigue el transpose de la canción"
        >
          T
        </button>
      </div>

      {/* Vertical fader + post-fader meter side by side, the way Ableton
          Live lays out its mixer. The fader is the native <input type=range>
          rotated via CSS (writing-mode: vertical-lr + direction: rtl) so
          the thumb travels bottom→top. The meter is a div whose height
          tracks the same `meters[trackId]` dictionary the DAW track
          headers already populate. */}
      <div className="lt-compact-mixer-fader-wrap">
        <input
          type="range"
          className="lt-compact-mixer-fader"
          min={0}
          max={1}
          step={0.005}
          value={volume}
          aria-label={`Volume ${track.name}`}
          onChange={handleVolumeInput}
          onDoubleClick={handleVolumeDoubleClick}
          onPointerUp={() => handlers.onCommitVolume(track.id)}
          onPointerCancel={() => handlers.onCommitVolume(track.id)}
          onKeyUp={(event) => {
            if (isStepperKey(event.key)) handlers.onCommitVolume(track.id);
          }}
        />
        <CompactMixerMeter trackId={track.id} />
      </div>

      {/* Pan slider. Horizontal so it doesn't claim more height inside the
          already-tall strip. -1 → L, 0 → C, +1 → R. The guide row above
          shows L/C/R tick labels so the user reads the slider without
          touching it, and a tooltip floats over the thumb while dragging. */}
      <div className="lt-compact-mixer-pan-wrap">
        <div className="lt-compact-mixer-pan-guides" aria-hidden="true">
          <span className="lt-compact-mixer-pan-guide is-left">L</span>
          <span className="lt-compact-mixer-pan-guide is-centre">C</span>
          <span className="lt-compact-mixer-pan-guide is-right">R</span>
        </div>
        <div className="lt-compact-mixer-pan-track">
          <input
            type="range"
            className="lt-compact-mixer-pan"
            min={-1}
            max={1}
            step={0.01}
            value={pan}
            aria-label={`Pan ${track.name}`}
            onChange={handlePanInput}
            onDoubleClick={handlePanDoubleClick}
            onPointerDown={() => setIsPanDragging(true)}
            onPointerUp={() => {
              setIsPanDragging(false);
              handlers.onCommitPan(track.id);
            }}
            onPointerCancel={() => {
              setIsPanDragging(false);
              handlers.onCommitPan(track.id);
            }}
            onKeyUp={(event) => {
              if (isStepperKey(event.key)) handlers.onCommitPan(track.id);
            }}
          />
          {isPanDragging ? (
            <div
              className="lt-compact-mixer-pan-tooltip"
              style={{ left: `${((pan + 1) / 2) * 100}%` }}
            >
              {formatPan(pan)}
            </div>
          ) : null}
        </div>
      </div>

      <select
        className="lt-compact-mixer-audio-to"
        value={track.audioTo}
        aria-label={`Audio routing for ${track.name}`}
        onChange={handleAudioToChange}
      >
        {audioRoutingOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const CompactMixerStrip = memo(CompactMixerStripComponent);

/**
 * Vertical post-fader peak meter that lives next to the strip's fader.
 * Subscribes to the per-track meter dictionary the audio engine already
 * publishes (see useAudioMeters) and animates the bar with the same
 * release ballistics the master fader meter uses, so the two views read
 * consistently. One bar, max(L, R) — same single-channel approach the rest
 * of the project's meters take for now.
 */
type CompactMixerMeterProps = {
  trackId: string;
};

function CompactMixerMeterComponent({ trackId }: CompactMixerMeterProps) {
  const fillRef = useRef<HTMLDivElement | null>(null);
  const animationStateRef = useRef({
    frameId: null as number | null,
    lastFrameAt: 0,
    currentDb: METER_MIN_DB,
    targetDb: METER_MIN_DB,
  });

  useEffect(() => {
    const animationState = animationStateRef.current;

    const applyFill = () => {
      const element = fillRef.current;
      if (!element) return;
      const scale = meterDbToDisplayScale(animationState.currentDb);
      element.style.height = `${(scale * 100).toFixed(2)}%`;
      element.style.opacity = scale > 0 ? "1" : "0";
    };

    const stopAnimation = () => {
      if (animationState.frameId !== null) {
        cancelAnimationFrame(animationState.frameId);
        animationState.frameId = null;
      }
      animationState.lastFrameAt = 0;
    };

    const step = (now: number) => {
      const elapsed =
        animationState.lastFrameAt > 0 ? now - animationState.lastFrameAt : 16.67;
      animationState.lastFrameAt = now;
      animationState.currentDb = stepMeterDb(
        animationState.currentDb,
        animationState.targetDb,
        elapsed,
        DEFAULT_METER_FALLOFF_DB_PER_SECOND,
      );
      applyFill();
      const settled =
        Math.abs(animationState.currentDb - animationState.targetDb) <
        METER_ACTIVE_EPSILON_DB;
      if (settled) {
        animationState.currentDb = animationState.targetDb;
        applyFill();
        stopAnimation();
        return;
      }
      animationState.frameId = requestAnimationFrame(step);
    };

    const schedule = () => {
      if (animationState.frameId !== null) return;
      animationState.frameId = requestAnimationFrame(step);
    };

    const initial = useTransportStore.getState().meters[trackId];
    const initialPeak = initial
      ? Math.max(initial.leftPeak, initial.rightPeak)
      : 0;
    animationState.currentDb = peakToMeterDb(initialPeak);
    animationState.targetDb = animationState.currentDb;
    applyFill();

    const unsubscribe = useTransportStore.subscribe(
      (state) => {
        const m = state.meters[trackId];
        return m ? Math.max(m.leftPeak, m.rightPeak) : 0;
      },
      (peak) => {
        animationState.targetDb = peakToMeterDb(peak);
        schedule();
      },
    );

    return () => {
      unsubscribe();
      stopAnimation();
    };
  }, [trackId]);

  return (
    <div className="lt-compact-mixer-meter" aria-hidden="true">
      <div className="lt-compact-mixer-meter-fill" ref={fillRef} />
    </div>
  );
}

const CompactMixerMeter = memo(CompactMixerMeterComponent);

function effectiveBool(
  optimistic: boolean | undefined,
  fallback: boolean,
): boolean {
  return optimistic ?? fallback;
}

function effectiveNumber(
  optimistic: number | undefined,
  fallback: number,
): number {
  return optimistic ?? fallback;
}

/** Pan value formatter for the drag tooltip: "C" at centre, "L 50" /
 * "R 32" otherwise. The numeric value is the percent of the half-range, so
 * pan = -0.5 reads as "L 50". Matches the convention used by Ableton's
 * pan tooltip. */
function formatPan(value: number): string {
  if (Math.abs(value) < 0.001) return "C";
  const side = value < 0 ? "L" : "R";
  const magnitude = Math.round(Math.abs(value) * 100);
  return `${side} ${magnitude}`;
}

function isStepperKey(key: string) {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "PageUp" ||
    key === "PageDown" ||
    key === "Home" ||
    key === "End"
  );
}

// Suppress unused-import lint for the optimistic-state type.
export type { OptimisticMixState };
