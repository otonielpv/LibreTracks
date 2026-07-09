import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import {
  TRACK_FADER_SCALE,
  faderTicks,
  formatDb,
  gainToPosition,
  positionToDb,
  positionToGain,
} from "@libretracks/shared/faderScale";

// Tick marks positioned at their true travel offset (0 dB is ~30% down, not
// centred). Computed once — the scale never changes.
const TRACK_FADER_TICKS = faderTicks(TRACK_FADER_SCALE);

import type { TrackSummary } from "./desktopApi";
import { TrackMeter } from "./TrackMeter";
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
  /** Track ids that currently have at least one clip inside the song
   * the playhead is on. Calculated by the parent because it has the
   * playhead + song data already. `null` means "no active song" —
   * in that case the filter is ignored and every track shows. */
  activeSongTrackIds: Set<string> | null;
  /** When true the mixer hides tracks that don't have a clip inside
   * the active song (using `activeSongTrackIds`). State is owned by
   * the parent so the toggle UI can live in the TimelineToolbar
   * instead of stealing strip-band space. */
  filterActiveSong: boolean;
} & CompactMixerProps_DragSelection;

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
  selectedTrackIds,
  onTrackSelect,
  onTrackDragStart,
  activeSongTrackIds,
  filterActiveSong,
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

  // Tracks the user will actually see. When the filter is on AND there
  // is an active song, keep tracks whose id is in the active-song set
  // PLUS every ancestor folder of those tracks (so the parent hierarchy
  // remains visible and a child doesn't appear orphaned). When the
  // filter is off, or no song is active, show everything as before.
  const visibleTracks = useMemo(() => {
    if (!filterActiveSong || !activeSongTrackIds) return tracks;
    const visibleIds = new Set<string>(activeSongTrackIds);
    // Walk each visible track upwards through parentTrackId and add
    // ancestors so folder strips don't disappear when their child does.
    for (const id of activeSongTrackIds) {
      let current = trackById.get(id);
      while (current?.parentTrackId) {
        if (visibleIds.has(current.parentTrackId)) break;
        visibleIds.add(current.parentTrackId);
        current = trackById.get(current.parentTrackId);
      }
    }
    return tracks.filter((track) => visibleIds.has(track.id));
  }, [filterActiveSong, activeSongTrackIds, tracks, trackById]);

  return (
    <div className="lt-compact-mixer">
      <div className="lt-compact-mixer-strips">
        {visibleTracks.map((track) => (
          <CompactMixerStrip
            key={track.id}
            track={track}
            audioRoutingOptions={audioRoutingOptions}
            handlers={handlers}
            parentInfo={parentInfoByTrackId.get(track.id) ?? null}
            onContextMenu={onTrackContextMenu}
            isSelected={selectedTrackIds.includes(track.id)}
            onSelect={onTrackSelect}
            onDragStart={onTrackDragStart}
          />
        ))}
      </div>
    </div>
  );
}

export const CompactMixer = memo(CompactMixerComponent);

type CompactMixerProps_DragSelection = {
  /** Track ids the user has selected. Mirrors the project-wide
   * selection so changes made from the DAW track header stay in sync
   * here, and vice-versa. */
  selectedTrackIds: string[];
  /** Forwarded down to each strip — shared with the DAW track header
   * so the multi-select rules (Ctrl/Shift) behave identically. */
  onTrackSelect: (
    trackId: string,
    trackName: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  /** Pointer-down on a strip handle starts the reorder drag. */
  onTrackDragStart: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
};

type CompactMixerStripProps = {
  track: TrackSummary;
  audioRoutingOptions: Array<{ value: string; label: string }>;
  handlers: CompactMixerHandlers;
  parentInfo: { color: string; name: string } | null;
  onContextMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
  /** True when this strip's track id is in the project selection. We
   * mirror the DAW track-header `is-selected` styling so the user
   * sees a consistent selection signal in both views. */
  isSelected: boolean;
  /** Click on a non-interactive part of the strip — selects this
   * track using the same shared selection logic as the DAW header
   * (single / Ctrl-toggle / Shift-range). Caller passes the event so
   * we don't duplicate the modifier-key decision tree here. */
  onSelect: (
    trackId: string,
    trackName: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  /** Pointer-down on a non-interactive part of the strip starts the
   * drag-to-reorder gesture. Caller decides if the move was big
   * enough to count as a drag (vs. plain click). Same contract the
   * DAW track header uses. */
  onDragStart: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
};

// Snap thresholds: when the slider lands within this fraction of the
// snap target, the value pulls to the target. 3% of the slider range
// matches the "feels-magnetic" zone in Ableton and most other DAWs.
// The fader now runs in *position* space [0,1] with an Ableton-style dB curve;
// unity (0 dB) lives at `unityPosition`, so that's where the fader snaps.
const VOLUME_SNAP_TARGET = TRACK_FADER_SCALE.unityPosition;
const VOLUME_SNAP_RANGE = 1.0; // fader position runs 0..1
const VOLUME_SNAP_THRESHOLD = VOLUME_SNAP_RANGE * 0.03;
const PAN_SNAP_TARGET = 0.0;
const PAN_SNAP_RANGE = 2.0; // slider runs -1..1
const PAN_SNAP_THRESHOLD = PAN_SNAP_RANGE * 0.03;
// Holding Shift while dragging a fader scales pointer travel by this factor for
// fine dB adjustments (Reaper-style). Also bypasses the snap, since a crawl
// doesn't want the magnet fighting it.
const FINE_DRAG_FACTOR = 0.25;

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
  isSelected,
  onSelect,
  onDragStart,
}: CompactMixerStripProps) {
  const { t } = useTranslation();
  const isFolder = track.kind === "folder";
  // Mirror the DAW TrackHeaderItem: tracks that live inside a folder
  // get an "Inherited (Folder)" option prepended to their routing
  // dropdown so the user can route the strip to the parent's bus
  // instead of picking an explicit destination.
  const effectiveRoutingOptions = useMemo(() => {
    if (!track.parentTrackId) {
      return audioRoutingOptions;
    }
    return [
      {
        value: "inherit",
        label: t("trackHeader.inherited", {
          defaultValue: "Inherited (Folder)",
        }),
      },
      ...audioRoutingOptions,
    ];
  }, [audioRoutingOptions, track.parentTrackId, t]);
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
  const volumePosition = gainToPosition(volume, TRACK_FADER_SCALE);
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
    // Reset to unity (0 dB, gain 1.0).
    handlers.onVolumeChange(track.id, 1.0);
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

  // Treat a mousedown/click on the strip background or its name area
  // as a track-selection / drag-start gesture. We deliberately ignore
  // clicks that originate on the toggle buttons, fader, pan slider,
  // routing select, or any other native control inside the strip —
  // those have their own handlers and shouldn't double-fire selection
  // or accidentally start a track drag while the user is moving a
  // fader. The `data-strip-noninteractive` data-attribute below is
  // the contract we use to mark "selectable" zones.
  const isSelectableTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest("[data-strip-noninteractive]"));
  };

  const handleStripMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (!isSelectableTarget(event.target)) return;
      onDragStart(event, track.id);
    },
    [onDragStart, track.id],
  );

  const handleStripClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (!isSelectableTarget(event.target)) return;
      onSelect(track.id, track.name, event);
    },
    [onSelect, track.id, track.name],
  );

  return (
    <div
      className={`lt-compact-mixer-strip ${
        isFolder ? "is-folder" : ""
      } ${parentInfo ? "is-child" : ""} ${isSelected ? "is-selected" : ""}`}
      data-track-id={track.id}
      style={
        {
          ["--track-accent" as string]: trackAccent,
          ...(parentInfo
            ? { ["--parent-accent" as string]: parentInfo.color }
            : null),
        } as React.CSSProperties
      }
      onMouseDown={handleStripMouseDown}
      onClick={handleStripClick}
      onContextMenu={(event) => onContextMenu(event, track.id)}
    >
      {/* The name + parent-hint band acts as the strip's "handle".
          data-strip-noninteractive opts it into selection / drag-start
          via the bubbling handlers on the strip root; controls below
          deliberately omit this attribute so they keep their own
          click semantics. */}
      <div
        className="lt-compact-mixer-strip-name"
        title={track.name}
        data-strip-noninteractive=""
      >
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
          data-strip-noninteractive=""
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
          Live lays out its mixer. The fader is a fully custom <div>
          slider driven by pointer events — we can't use a native
          <input type=range> here because the recipes for rotating it
          90° (writing-mode + appearance:slider-vertical) all force
          trade-offs: either the thumb travels horizontally, or
          appearance:slider-vertical wins but discards our custom
          thumb colour. The custom path lets us reuse the exact same
          teal-on-black look the DAW track-volume slider uses, and
          travel bottom→top reliably. The meter is a div whose height
          tracks the same `meters[trackId]` dictionary the DAW track
          headers already populate. */}
      <div className="lt-compact-mixer-fader-wrap">
        <div className="lt-compact-mixer-fader-scale" aria-hidden="true">
          {TRACK_FADER_TICKS.map((tick) => (
            <span
              key={tick.label}
              style={{ top: `${(tick.offsetFromTop * 100).toFixed(2)}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
        <CompactVerticalFader
          value={volumePosition}
          onChange={(nextPosition) =>
            handlers.onVolumeChange(
              track.id,
              positionToGain(
                applySnap(
                  nextPosition,
                  VOLUME_SNAP_TARGET,
                  VOLUME_SNAP_THRESHOLD,
                  shiftPressedRef.current,
                ),
                TRACK_FADER_SCALE,
              ),
            )
          }
          onCommit={() => handlers.onCommitVolume(track.id)}
          onDoubleClick={handleVolumeDoubleClick}
          ariaLabel={`Volume ${track.name}`}
        />
        <TrackMeter trackId={track.id} />
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
            // Two-tone azul→negro gradient — identical to the DAW
            // track-pan slider (TrackHeaderItem.tsx). `panFill` maps
            // pan ∈ [-1,1] to a 0..100% position on the horizontal axis.
            style={{
              background: `linear-gradient(to right, #4d79d8 0%, #74b8ff ${(((pan + 1) * 0.5) * 100).toFixed(2)}%, #0e0e0e ${(((pan + 1) * 0.5) * 100).toFixed(2)}%, #0e0e0e 100%)`,
            }}
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
        {effectiveRoutingOptions.map((option) => (
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
 * Vertical fader rendered as a custom <div> + pointer events so we can
 * keep the DAW-style colours (teal fill below the thumb on a #0e0e0e
 * track + saturated teal thumb) while travelling bottom→top reliably.
 * The native <input type=range> route requires either appearance:
 * slider-vertical (which discards custom thumb colouring) or a CSS
 * writing-mode rotation (which in this build mis-rotated the slider
 * into a horizontal one). Custom path sidesteps both gotchas.
 *
 *   value:        current value in [0, 1].
 *   onChange:     called on every pointer move with the new value.
 *                 Caller is responsible for any snap behaviour.
 *   onCommit:     called once the user releases or cancels — same
 *                 contract the original <input> handlers had.
 *   onDoubleClick: reset-to-unity shortcut; caller commits.
 *   ariaLabel:    accessible label propagated to the slider role.
 */
type CompactVerticalFaderProps = {
  value: number;
  onChange: (next: number) => void;
  onCommit: () => void;
  onDoubleClick: () => void;
  ariaLabel: string;
};

function CompactVerticalFaderComponent({
  value,
  onChange,
  onCommit,
  onDoubleClick,
  ariaLabel,
}: CompactVerticalFaderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const clamp = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

  // Fine-drag anchor: while Shift is held mid-drag we move incrementally from
  // where the pointer was when Shift went down, scaled by FINE_DRAG_FACTOR, so
  // the fader crawls for precise dB tweaks (Reaper-style). Re-anchored whenever
  // Shift toggles so the thumb never jumps.
  const fineAnchorRef = useRef<{ clientY: number; value: number } | null>(null);
  const latestValueRef = useRef(value);
  latestValueRef.current = value;

  // Map a clientY inside the track to a value in [0, 1] with the
  // bottom of the track being 0 and the top being 1 — i.e. the way
  // every mixer fader on the planet works.
  const valueFromClientY = useCallback((clientY: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    const offsetFromBottom = rect.bottom - clientY;
    return clamp(offsetFromBottom / rect.height);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Only react to primary button drags. Right-click / middle-click
      // should fall through to the strip-level context menu.
      if (event.button !== 0) return;
      event.preventDefault();
      const target = trackRef.current;
      if (!target) return;
      target.setPointerCapture(event.pointerId);
      draggingRef.current = true;
      setIsDragging(true);
      if (event.shiftKey) {
        // Start a fine drag: anchor here, keep the current value (no jump).
        fineAnchorRef.current = { clientY: event.clientY, value };
      } else {
        fineAnchorRef.current = null;
        onChange(valueFromClientY(event.clientY));
      }
    },
    [onChange, value, valueFromClientY],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;

      if (event.shiftKey) {
        const track = trackRef.current;
        const height = track?.getBoundingClientRect().height ?? 0;
        if (height <= 0) return;
        // (Re-)anchor when Shift is first pressed mid-drag so the thumb stays
        // put and only subsequent movement is scaled.
        if (!fineAnchorRef.current) {
          fineAnchorRef.current = {
            clientY: event.clientY,
            value: latestValueRef.current,
          };
        }
        const anchor = fineAnchorRef.current;
        const deltaPixels = anchor.clientY - event.clientY; // up = positive
        const next = anchor.value + (deltaPixels / height) * FINE_DRAG_FACTOR;
        onChange(clamp(next));
        return;
      }

      // Shift released mid-drag → resume absolute tracking from the pointer.
      fineAnchorRef.current = null;
      onChange(valueFromClientY(event.clientY));
    },
    [onChange, valueFromClientY],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      fineAnchorRef.current = null;
      setIsDragging(false);
      const target = trackRef.current;
      if (target?.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      onCommit();
    },
    [onCommit],
  );

  // Keyboard support — Arrow up/down nudge by 1%, Home/End jump.
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      let next: number | null = null;
      if (event.key === "ArrowUp" || event.key === "ArrowRight") {
        next = clamp(value + 0.01);
      } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
        next = clamp(value - 0.01);
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = 1;
      }
      if (next === null) return;
      event.preventDefault();
      onChange(next);
    },
    [onChange, value],
  );

  const handleKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isStepperKey(event.key)) onCommit();
    },
    [onCommit],
  );

  const fillPct = (value * 100).toFixed(2);
  return (
    <div
      ref={trackRef}
      className="lt-compact-mixer-fader"
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={value}
      aria-orientation="vertical"
      // Teal fill below the thumb, black above — same gradient pattern
      // the DAW track-volume slider uses.
      style={{
        background: `linear-gradient(to top, #3cddc7 ${fillPct}%, #0e0e0e ${fillPct}%)`,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      <div
        className="lt-compact-mixer-fader-thumb"
        style={{ bottom: `${fillPct}%` }}
        aria-hidden="true"
      />
      {isDragging ? (
        <div
          className="lt-compact-mixer-fader-tooltip"
          style={{ bottom: `${fillPct}%` }}
        >
          {formatVolume(value)}
        </div>
      ) : null}
    </div>
  );
}

const CompactVerticalFader = memo(CompactVerticalFaderComponent);

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

/** Volume formatter for the vertical-fader tooltip. The fader runs in
 * *position* space [0,1]; show the dB value at that position (0 dB = unity). */
function formatVolume(position: number): string {
  return `${formatDb(positionToDb(position, TRACK_FADER_SCALE))} dB`;
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
