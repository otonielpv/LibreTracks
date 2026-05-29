import { memo, useCallback, type ChangeEvent } from "react";

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
};

function CompactMixerComponent({
  tracks,
  audioRoutingOptions,
  handlers,
}: CompactMixerProps) {
  return (
    <div className="lt-compact-mixer">
      <div className="lt-compact-mixer-strips">
        {tracks.map((track) => (
          <CompactMixerStrip
            key={track.id}
            track={track}
            audioRoutingOptions={audioRoutingOptions}
            handlers={handlers}
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
};

function CompactMixerStripComponent({
  track,
  audioRoutingOptions,
  handlers,
}: CompactMixerStripProps) {
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

  const handleVolumeInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = Number(event.target.value);
      if (!Number.isFinite(next)) return;
      handlers.onVolumeChange(track.id, next);
    },
    [handlers, track.id],
  );

  const handlePanInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = Number(event.target.value);
      if (!Number.isFinite(next)) return;
      handlers.onPanChange(track.id, next);
    },
    [handlers, track.id],
  );

  const handleAudioToChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      handlers.onAudioToChange(track.id, event.target.value);
    },
    [handlers, track.id],
  );

  return (
    <div
      className="lt-compact-mixer-strip"
      style={
        track.color
          ? ({ ["--track-accent" as string]: track.color } as React.CSSProperties)
          : undefined
      }
    >
      <div className="lt-compact-mixer-strip-name" title={track.name}>
        {track.name}
      </div>

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

      {/* Vertical fader. The native <input type=range> rotates via CSS
          (writing-mode: vertical-lr + direction: rtl) so the thumb travels
          bottom→top as expected for a mixer fader. */}
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
          onPointerUp={() => handlers.onCommitVolume(track.id)}
          onPointerCancel={() => handlers.onCommitVolume(track.id)}
          onKeyUp={(event) => {
            if (isStepperKey(event.key)) handlers.onCommitVolume(track.id);
          }}
        />
      </div>

      {/* Pan slider. Horizontal so it doesn't claim more height inside the
          already-tall strip. -1 → L, 0 → C, +1 → R. */}
      <div className="lt-compact-mixer-pan-wrap">
        <input
          type="range"
          className="lt-compact-mixer-pan"
          min={-1}
          max={1}
          step={0.01}
          value={pan}
          aria-label={`Pan ${track.name}`}
          onChange={handlePanInput}
          onPointerUp={() => handlers.onCommitPan(track.id)}
          onPointerCancel={() => handlers.onCommitPan(track.id)}
          onKeyUp={(event) => {
            if (isStepperKey(event.key)) handlers.onCommitPan(track.id);
          }}
        />
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
