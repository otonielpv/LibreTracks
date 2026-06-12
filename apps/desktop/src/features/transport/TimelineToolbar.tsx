import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  meterDbToDisplayScale,
  peakToMeterDb,
  stepMeterDb,
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_ACTIVE_EPSILON_DB,
  METER_MIN_DB,
} from "@libretracks/shared/meterBallistics";

import { formatTransposeSemitones, type SongRegionSummary } from "./desktopApi";
import { useTransportStore } from "./store";
import type {
  GlobalJumpMode,
  SongJumpTrigger,
  SongTransitionMode,
  VampMode,
} from "./uiStore";

type RegionMasterFaderProps = {
  regionId: string;
  masterGain: number;
  disabled: boolean;
  onChange: (nextGain: number) => void;
  onCommit: () => void;
};

// Master fader snaps to unity (1.0) within ±3% of the slider range (0..2),
// matching the compact view's master snap so both views feel identical.
// Holding Shift while dragging bypasses the snap; double-click resets.
const MASTER_SNAP_TARGET = 1.0;
const MASTER_SNAP_THRESHOLD = 2.0 * 0.03;

function applyMasterSnap(value: number, bypass: boolean): number {
  if (bypass) return value;
  return Math.abs(value - MASTER_SNAP_TARGET) <= MASTER_SNAP_THRESHOLD
    ? MASTER_SNAP_TARGET
    : value;
}

function RegionMasterFaderComponent({
  regionId,
  masterGain,
  disabled,
  onChange,
  onCommit,
}: RegionMasterFaderProps) {
  const meterFillRef = useRef<HTMLDivElement | null>(null);
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
  const animationStateRef = useRef({
    frameId: null as number | null,
    lastFrameAt: 0,
    currentDb: METER_MIN_DB,
    targetDb: METER_MIN_DB,
  });

  useEffect(() => {
    const animationState = animationStateRef.current;

    const applyFill = () => {
      const element = meterFillRef.current;
      if (!element) return;
      const scale = meterDbToDisplayScale(animationState.currentDb);
      element.style.width = `${(scale * 100).toFixed(2)}%`;
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

    const scheduleAnimation = () => {
      if (animationState.frameId !== null) return;
      animationState.frameId = requestAnimationFrame(step);
    };

    const updateTarget = (rawPeak: number) => {
      animationState.targetDb = peakToMeterDb(rawPeak);
      scheduleAnimation();
    };

    const initialPeak = useTransportStore.getState().regionMeters[regionId] ?? 0;
    animationState.currentDb = peakToMeterDb(initialPeak);
    animationState.targetDb = animationState.currentDb;
    applyFill();

    const unsubscribe = useTransportStore.subscribe(
      (state) => state.regionMeters[regionId] ?? 0,
      (peak) => {
        updateTarget(peak);
      },
    );

    return () => {
      unsubscribe();
      stopAnimation();
      animationState.currentDb = METER_MIN_DB;
      animationState.targetDb = METER_MIN_DB;
      const element = meterFillRef.current;
      if (element) {
        element.style.width = "0%";
        element.style.opacity = "0";
      }
    };
  }, [regionId]);

  return (
    <div className="lt-region-master-fader">
      <div className="lt-region-master-fader-meter" aria-hidden="true">
        <div className="lt-region-master-fader-meter-fill" ref={meterFillRef} />
      </div>
      <input
        className="lt-region-master-fader-slider"
        aria-label="Region master gain"
        type="range"
        min={0}
        max={2}
        step={0.01}
        value={masterGain}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value) || 0;
          onChange(applyMasterSnap(next, shiftPressedRef.current));
        }}
        onDoubleClick={() => {
          onChange(MASTER_SNAP_TARGET);
          onCommit();
        }}
        onPointerUp={() => onCommit()}
        onPointerCancel={() => onCommit()}
        onKeyUp={(event) => {
          // Commit on arrow-key release so keyboard users get undo entries
          // matching what mouse users get on pointer-up.
          if (
            event.key === "ArrowUp" ||
            event.key === "ArrowDown" ||
            event.key === "ArrowLeft" ||
            event.key === "ArrowRight" ||
            event.key === "PageUp" ||
            event.key === "PageDown" ||
            event.key === "Home" ||
            event.key === "End"
          ) {
            onCommit();
          }
        }}
      />
    </div>
  );
}

const RegionMasterFader = memo(RegionMasterFaderComponent);

type TimelineToolbarProps = {
  snapEnabled: boolean;
  subdivisionPerBeat: number;
  selectedRegion: SongRegionSummary | null;
  globalJumpMode: GlobalJumpMode;
  globalJumpBars: number;
  songJumpTrigger: SongJumpTrigger;
  songJumpBars: number;
  songTransitionMode: SongTransitionMode;
  vampMode: VampMode;
  vampBars: number;
  isVampActive: boolean;
  pendingMarkerJumpLabel: string | null;
  isProjectEmpty: boolean;
  trackCount: number;
  clipCount: number;
  markerCount: number;
  followPlayheadEnabled: boolean;
  onToggleSnap: () => void;
  onToggleFollowPlayhead: () => void;
  onGlobalJumpModeChange: (mode: GlobalJumpMode) => void;
  onGlobalJumpBarsChange: (bars: number) => void;
  onSongJumpTriggerChange: (trigger: SongJumpTrigger) => void;
  onSongJumpBarsChange: (bars: number) => void;
  onSongTransitionModeChange: (mode: SongTransitionMode) => void;
  onVampModeChange: (mode: VampMode) => void;
  onVampBarsChange: (bars: number) => void;
  onToggleVamp: () => void;
  onCancelPendingJump: () => void;
  onSelectedRegionTransposeChange: (nextTransposeSemitones: number) => void;
  /** Effective timeline BPM at the start of the selected region. */
  selectedRegionEffectiveBpm: number;
  onSelectedRegionWarpToggle: (nextEnabled: boolean) => void;
  onSelectedRegionMasterGainChange: (nextMasterGain: number) => void;
  onSelectedRegionMasterGainCommit: () => void;
  viewMode: "daw" | "compact";
  onToggleViewMode: () => void;
  /** Only meaningful in compact view: the compact mixer hides tracks
   * that don't have a clip in the active song when this is on.
   * Lifted to the toolbar so the toggle button has somewhere natural
   * to live, instead of stealing space from the mixer band. */
  compactMixerFilterActiveSong: boolean;
  onToggleCompactMixerFilterActiveSong: () => void;
  /** True when there's a song under the playhead — the filter has
   * something to act on. When false we render the button disabled so
   * the user gets a visual cue that toggling it won't change anything
   * right now. */
  compactMixerFilterAvailable: boolean;
  midiLearnMode: string | null;
  onMidiLearnTarget: (controlKey: string) => void;
};

type ControlGroupProps = {
  title: string;
  summary?: string;
  open: boolean;
  onToggleOpen: () => void;
  children?: ReactNode;
  details?: ReactNode;
  action?: ReactNode;
  className?: string;
};

function ControlGroup({
  title,
  summary,
  open,
  onToggleOpen,
  children,
  details,
  action,
  className,
}: ControlGroupProps) {
  return (
    <section className={`lt-control-group ${className ?? ""}`}>
      <div className="lt-control-group-main">
        <div className="lt-control-group-copy">
          <span className="lt-control-group-title">{title}</span>
          {summary ? <p>{summary}</p> : null}
        </div>
        {action ? (
          <div className="lt-control-group-action">{action}</div>
        ) : null}
        <div className={`lt-control-popover ${open ? "is-open" : ""}`}>
          <button
            type="button"
            className="lt-control-popover-trigger"
            aria-label={`${title} settings`}
            aria-expanded={open}
            onClick={onToggleOpen}
          >
            <span className="material-symbols-outlined">tune</span>
          </button>

          {open ? (
            <div className="lt-control-popover-panel">
              <div className="lt-control-popover-header">
                <span>{title}</span>
                {summary ? <strong>{summary}</strong> : null}
              </div>
              <div className="lt-control-group-body">
                <div className="lt-control-group-actions">{children}</div>
                {details ? (
                  <div className="lt-control-group-details">{details}</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function TimelineToolbar({
  snapEnabled,
  subdivisionPerBeat,
  selectedRegion,
  globalJumpMode,
  globalJumpBars,
  songJumpTrigger,
  songJumpBars,
  songTransitionMode,
  vampMode,
  vampBars,
  isVampActive,
  pendingMarkerJumpLabel,
  isProjectEmpty,
  trackCount,
  clipCount,
  markerCount,
  followPlayheadEnabled,
  onToggleSnap,
  onToggleFollowPlayhead,
  onGlobalJumpModeChange,
  onGlobalJumpBarsChange,
  onSongJumpTriggerChange,
  onSongJumpBarsChange,
  onSongTransitionModeChange,
  onVampModeChange,
  onVampBarsChange,
  onToggleVamp,
  onCancelPendingJump,
  onSelectedRegionTransposeChange,
  selectedRegionEffectiveBpm,
  onSelectedRegionWarpToggle,
  onSelectedRegionMasterGainChange,
  onSelectedRegionMasterGainCommit,
  viewMode,
  onToggleViewMode,
  compactMixerFilterActiveSong,
  onToggleCompactMixerFilterActiveSong,
  compactMixerFilterAvailable,
  midiLearnMode,
  onMidiLearnTarget,
}: TimelineToolbarProps) {
  const { t } = useTranslation();
  const learnModeActive = midiLearnMode !== null;
  const [openGroup, setOpenGroup] = useState<
    "jump" | "vamp" | "song" | "region" | "warp" | "master" | null
  >(null);
  const toolbarRootRef = useRef<HTMLDivElement | null>(null);

  // Close any open popover when the user clicks/taps outside the toolbar.
  // Listening on pointerdown (capture) lets us react before the popover's
  // own handlers re-open another group on the same gesture.
  useEffect(() => {
    if (openGroup === null) return;
    const handlePointerDown = (event: PointerEvent) => {
      const root = toolbarRootRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setOpenGroup(null);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [openGroup]);
  const controlsDisabled = isProjectEmpty && !learnModeActive;
  const jumpSummary =
    globalJumpMode === "after_bars"
      ? `${globalJumpBars} bars`
      : globalJumpMode === "next_marker"
        ? t("transport.jumpMode.nextMarker")
        : t("transport.jumpMode.immediate");
  const songJumpSummary =
    songJumpTrigger === "after_bars"
      ? `${songJumpBars} bars`
      : songJumpTrigger === "region_end"
        ? t("transport.jumpMode.regionEnd")
        : t("transport.jumpMode.immediate");
  const songTransitionSummary =
    songTransitionMode === "fade_out"
      ? t("timelineToolbar.songTransitionFadeOut")
      : t("timelineToolbar.songTransitionInstant");
  const songSummary = `${songJumpSummary} / ${songTransitionSummary}`;
  const regionSummary = selectedRegion
    ? `${formatTransposeSemitones(selectedRegion.transposeSemitones)} st`
    : t("timelineToolbar.regionTransposeNoSelection");
  const regionControlsDisabled = controlsDisabled || !selectedRegion;

  const warpEnabled = selectedRegion?.warpEnabled ?? false;
  const warpSourceBpm = selectedRegion?.warpSourceBpm ?? null;
  const warpRatio =
    warpEnabled &&
    warpSourceBpm &&
    warpSourceBpm > 0 &&
    selectedRegionEffectiveBpm > 0
      ? selectedRegionEffectiveBpm / warpSourceBpm
      : null;
  const warpSummary = selectedRegion
    ? warpEnabled && warpSourceBpm && warpRatio
      ? t("timelineToolbar.regionWarpRatioDisplay", {
          source: warpSourceBpm.toFixed(0),
          target: selectedRegionEffectiveBpm.toFixed(0),
          ratio: warpRatio.toFixed(3),
        })
      : t("timelineToolbar.regionWarpSummaryOff")
    : t("timelineToolbar.regionWarpNoSelection");
  const warpControlsDisabled = controlsDisabled || !selectedRegion;

  // Read the optimistic value (set during drag) if present, otherwise fall
  // back to the snapshot value. This is what lets the thumb track the
  // pointer with no IPC delay — same pattern as TrackMixer volume.
  const optimisticMasterGain = useTransportStore((state) =>
    selectedRegion ? state.optimisticRegionMaster[selectedRegion.id] : undefined,
  );
  const masterGain =
    optimisticMasterGain ?? selectedRegion?.master?.gain ?? 1.0;
  const masterGainDb =
    masterGain > 0 ? 20 * Math.log10(masterGain) : Number.NEGATIVE_INFINITY;
  const masterSummary = selectedRegion
    ? `${masterGain.toFixed(2)}× (${
        Number.isFinite(masterGainDb) ? `${masterGainDb.toFixed(1)} dB` : "-∞ dB"
      })`
    : t("timelineToolbar.regionMasterNoSelection");
  const masterControlsDisabled = controlsDisabled || !selectedRegion;

  const handleModeButtonClick = (learnKey: string, commit: () => void) => {
    if (learnModeActive) {
      onMidiLearnTarget(learnKey);
      return;
    }

    commit();
  };

  return (
    <div className="lt-timeline-topline" ref={toolbarRootRef}>
      <div className="lt-timeline-meta">
        <div className="lt-timeline-controls lt-bottom-controls">
          <button
            type="button"
            className={`lt-icon-button ${viewMode === "compact" ? "is-active" : ""}`}
            aria-label={
              viewMode === "compact"
                ? "Cambiar a vista DAW"
                : "Cambiar a vista compacta"
            }
            aria-pressed={viewMode === "compact"}
            title={
              viewMode === "compact"
                ? "Vista compacta (pulsa Tab para volver a DAW)"
                : "Vista DAW (pulsa Tab para cambiar a compacta)"
            }
            onClick={onToggleViewMode}
          >
            <span className="material-symbols-outlined">
              {viewMode === "compact" ? "view_timeline" : "view_module"}
            </span>
          </button>

          {viewMode === "compact" ? (
            <button
              type="button"
              className={`lt-icon-button ${
                compactMixerFilterActiveSong ? "is-active" : ""
              }`}
              aria-label={
                compactMixerFilterActiveSong
                  ? "Mostrar todos los tracks en el mixer"
                  : "Mostrar solo los tracks de la cancion activa en el mixer"
              }
              aria-pressed={compactMixerFilterActiveSong}
              title={
                compactMixerFilterAvailable
                  ? compactMixerFilterActiveSong
                    ? "Mostrando solo tracks de la cancion activa"
                    : "Mostrar solo tracks de la cancion activa"
                  : "Sin cancion activa: el filtro no tiene efecto ahora"
              }
              disabled={
                !compactMixerFilterAvailable && !compactMixerFilterActiveSong
              }
              onClick={onToggleCompactMixerFilterActiveSong}
            >
              <span className="material-symbols-outlined">
                {compactMixerFilterActiveSong ? "filter_alt" : "filter_alt_off"}
              </span>
            </button>
          ) : null}

          <button
            type="button"
            className={`lt-icon-button ${snapEnabled ? "is-active" : ""}`}
            aria-label={
              snapEnabled
                ? t("timelineToolbar.disableSnap")
                : t("timelineToolbar.enableSnap")
            }
            aria-pressed={snapEnabled}
            title={t("timelineToolbar.snapTitle", {
              subdivision: subdivisionPerBeat,
            })}
            onClick={onToggleSnap}
          >
            {/* Horseshoe-magnet glyph drawn as inline SVG. Material
                Symbols' `magnet` names aren't in this build so we ship
                the shape ourselves: two thick parallel arms joined by a
                wide rounded curve at the bottom, with the two pole tips
                at the top — this reads as a magnet at small sizes much
                better than the previous U-with-tick-marks attempt. When
                snap is off we overlay a diagonal slash so the toggle
                state is unmistakable without relying on colour. */}
            <svg
              className="lt-snap-icon"
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {/* Left arm — vertical bar from top tip down to the curve */}
              <line x1="5.5" y1="4" x2="5.5" y2="13" />
              {/* Right arm — mirror of the left */}
              <line x1="18.5" y1="4" x2="18.5" y2="13" />
              {/* Bottom curve joining both arms */}
              <path d="M5.5 13a6.5 6.5 0 0 0 13 0" />
              {/* Pole tips (small horizontal caps so it reads as a
                  magnet, not a tuning fork) */}
              <line x1="3" y1="4" x2="8" y2="4" />
              <line x1="16" y1="4" x2="21" y2="4" />
              {!snapEnabled ? <line x1="4" y1="20" x2="20" y2="4" /> : null}
            </svg>
          </button>

          <button
            type="button"
            className={`lt-icon-button ${followPlayheadEnabled ? "is-active" : ""}`}
            aria-label={
              followPlayheadEnabled
                ? t("timelineToolbar.disableFollowPlayhead")
                : t("timelineToolbar.enableFollowPlayhead")
            }
            aria-pressed={followPlayheadEnabled}
            title={t("timelineToolbar.followPlayheadTitle")}
            disabled={controlsDisabled}
            onClick={onToggleFollowPlayhead}
          >
            <span className="material-symbols-outlined">my_location</span>
          </button>

          <ControlGroup
            title={t("timelineToolbar.vampModeLabel")}
            summary={
              vampMode === "bars"
                ? `${vampBars} bars`
                : t("timelineToolbar.vampSectionOption")
            }
            open={openGroup === "vamp"}
            onToggleOpen={() =>
              setOpenGroup((current) => (current === "vamp" ? null : "vamp"))
            }
            className="lt-control-group-vamp"
            action={
              <button
                type="button"
                className={`lt-compact-action lt-vamp-button ${isVampActive ? "is-active" : ""}`}
                aria-label={t("timelineToolbar.vampToggle")}
                disabled={controlsDisabled}
                onClick={() => {
                  if (learnModeActive) {
                    onMidiLearnTarget("action:toggle_vamp");
                    return;
                  }

                  onToggleVamp();
                }}
              >
                <span className="material-symbols-outlined">repeat</span>
                <span>{t("timelineToolbar.vampButton")}</span>
              </button>
            }
            details={
              <>
                {vampMode === "bars" ? (
                  <label className="lt-stepper-control">
                    <span>{t("timelineToolbar.vampBarsLabel")}</span>
                    <div className="lt-stepper-control-row">
                      <button
                        type="button"
                        aria-label={t("timelineToolbar.vampBarsAria")}
                        disabled={controlsDisabled}
                        onClick={() => {
                          if (learnModeActive) {
                            onMidiLearnTarget("action:decrease_vamp_bars");
                            return;
                          }

                          onVampBarsChange(Math.max(1, vampBars - 1));
                        }}
                      >
                        -
                      </button>
                      <input
                        aria-label={t("timelineToolbar.vampBarsAria")}
                        type="number"
                        min={1}
                        step={1}
                        value={vampBars}
                        onPointerDown={(event) => {
                          if (!learnModeActive) {
                            return;
                          }

                          event.preventDefault();
                          event.stopPropagation();
                          onMidiLearnTarget("param:vamp_bars");
                        }}
                        onChange={(event) =>
                          onVampBarsChange(Number(event.target.value) || 1)
                        }
                      />
                      <button
                        type="button"
                        aria-label={t("timelineToolbar.vampBarsAria")}
                        disabled={controlsDisabled}
                        onClick={() => {
                          if (learnModeActive) {
                            onMidiLearnTarget("action:increase_vamp_bars");
                            return;
                          }

                          onVampBarsChange(vampBars + 1);
                        }}
                      >
                        +
                      </button>
                    </div>
                  </label>
                ) : null}
              </>
            }
          >
            <div
              className="lt-segmented-control"
              role="group"
              aria-label={t("timelineToolbar.vampModeAria")}
            >
              <button
                type="button"
                className={vampMode === "section" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick("action:set_vamp_mode_section", () =>
                    onVampModeChange("section"),
                  )
                }
              >
                {t("timelineToolbar.vampSectionOption")}
              </button>
              <button
                type="button"
                className={vampMode === "bars" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick("action:set_vamp_mode_bars", () =>
                    onVampModeChange("bars"),
                  )
                }
              >
                {t("timelineToolbar.vampBarsOption")}
              </button>
            </div>
          </ControlGroup>

          <ControlGroup
            title={t("timelineToolbar.markerJumpLabel")}
            summary={jumpSummary}
            open={openGroup === "jump"}
            onToggleOpen={() =>
              setOpenGroup((current) => (current === "jump" ? null : "jump"))
            }
            className="lt-control-group-jump"
            details={
              <>
                {globalJumpMode === "after_bars" ? (
                  <label className="lt-stepper-control">
                    <span>{t("timelineToolbar.markerBarsLabel")}</span>
                    <div className="lt-stepper-control-row">
                      <button
                        type="button"
                        aria-label={t("timelineToolbar.markerBarsLabel")}
                        disabled={controlsDisabled}
                        onClick={() => {
                          if (learnModeActive) {
                            onMidiLearnTarget(
                              "action:decrease_global_jump_bars",
                            );
                            return;
                          }

                          onGlobalJumpBarsChange(
                            Math.max(1, globalJumpBars - 1),
                          );
                        }}
                      >
                        -
                      </button>
                      <input
                        aria-label={t("timelineToolbar.markerJumpBarsAria")}
                        type="number"
                        min={1}
                        step={1}
                        value={globalJumpBars}
                        onPointerDown={(event) => {
                          if (!learnModeActive) {
                            return;
                          }

                          event.preventDefault();
                          event.stopPropagation();
                          onMidiLearnTarget("param:global_jump_bars");
                        }}
                        onChange={(event) =>
                          onGlobalJumpBarsChange(
                            Number(event.target.value) || 1,
                          )
                        }
                      />
                      <button
                        type="button"
                        aria-label={t("timelineToolbar.markerBarsLabel")}
                        disabled={controlsDisabled}
                        onClick={() => {
                          if (learnModeActive) {
                            onMidiLearnTarget(
                              "action:increase_global_jump_bars",
                            );
                            return;
                          }

                          onGlobalJumpBarsChange(globalJumpBars + 1);
                        }}
                      >
                        +
                      </button>
                    </div>
                  </label>
                ) : null}
                {pendingMarkerJumpLabel ? (
                  <span>{pendingMarkerJumpLabel}</span>
                ) : null}
              </>
            }
          >
            <div
              className="lt-segmented-control"
              role="group"
              aria-label={t("timelineToolbar.markerJumpModeAria")}
            >
              <button
                type="button"
                className={globalJumpMode === "immediate" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick(
                    "action:set_global_jump_mode_immediate",
                    () => onGlobalJumpModeChange("immediate"),
                  )
                }
              >
                {t("transport.jumpMode.immediate")}
              </button>
              <button
                type="button"
                className={globalJumpMode === "after_bars" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick(
                    "action:set_global_jump_mode_after_bars",
                    () => onGlobalJumpModeChange("after_bars"),
                  )
                }
              >
                {t("timelineToolbar.afterBarsOption")}
              </button>
              <button
                type="button"
                className={globalJumpMode === "next_marker" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick(
                    "action:set_global_jump_mode_next_marker",
                    () => onGlobalJumpModeChange("next_marker"),
                  )
                }
              >
                {t("transport.jumpMode.nextMarker")}
              </button>
            </div>
          </ControlGroup>

          <ControlGroup
            title={t("timelineToolbar.songTransitionLabel")}
            summary={songSummary}
            open={openGroup === "song"}
            onToggleOpen={() =>
              setOpenGroup((current) => (current === "song" ? null : "song"))
            }
            className="lt-control-group-song"
            details={
              <>
                {songJumpTrigger === "after_bars" ? (
                  <label className="lt-stepper-control">
                    <span>{t("timelineToolbar.songBarsLabel")}</span>
                    <div className="lt-stepper-control-row">
                      <button
                        type="button"
                        aria-label={t("timelineToolbar.songJumpBarsAria")}
                        disabled={controlsDisabled}
                        onClick={() => {
                          if (learnModeActive) {
                            onMidiLearnTarget("action:decrease_song_jump_bars");
                            return;
                          }

                          onSongJumpBarsChange(Math.max(1, songJumpBars - 1));
                        }}
                      >
                        -
                      </button>
                      <input
                        aria-label={t("timelineToolbar.songJumpBarsAria")}
                        type="number"
                        min={1}
                        step={1}
                        value={songJumpBars}
                        onPointerDown={(event) => {
                          if (!learnModeActive) {
                            return;
                          }

                          event.preventDefault();
                          event.stopPropagation();
                          onMidiLearnTarget("param:song_jump_bars");
                        }}
                        onChange={(event) =>
                          onSongJumpBarsChange(Number(event.target.value) || 1)
                        }
                      />
                      <button
                        type="button"
                        aria-label={t("timelineToolbar.songJumpBarsAria")}
                        disabled={controlsDisabled}
                        onClick={() => {
                          if (learnModeActive) {
                            onMidiLearnTarget("action:increase_song_jump_bars");
                            return;
                          }

                          onSongJumpBarsChange(songJumpBars + 1);
                        }}
                      >
                        +
                      </button>
                    </div>
                  </label>
                ) : null}
              </>
            }
          >
            <div
              className="lt-segmented-control"
              role="group"
              aria-label={t("timelineToolbar.songJumpModeAria")}
            >
              <button
                type="button"
                className={songJumpTrigger === "immediate" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick(
                    "action:set_song_jump_trigger_immediate",
                    () => onSongJumpTriggerChange("immediate"),
                  )
                }
              >
                {t("transport.jumpMode.immediate")}
              </button>
              <button
                type="button"
                className={songJumpTrigger === "region_end" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick(
                    "action:set_song_jump_trigger_region_end",
                    () => onSongJumpTriggerChange("region_end"),
                  )
                }
              >
                {t("transport.jumpMode.regionEnd")}
              </button>
              <button
                type="button"
                className={songJumpTrigger === "after_bars" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick(
                    "action:set_song_jump_trigger_after_bars",
                    () => onSongJumpTriggerChange("after_bars"),
                  )
                }
              >
                {t("timelineToolbar.afterBarsOption")}
              </button>
            </div>
            <div className="lt-song-transition-row">
              <button
                type="button"
                className={`lt-vamp-button ${songTransitionMode === "instant" ? "is-active" : ""}`}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick(
                    "action:set_song_transition_instant",
                    () => onSongTransitionModeChange("instant"),
                  )
                }
              >
                {t("timelineToolbar.songTransitionInstant")}
              </button>
              <button
                type="button"
                className={`lt-vamp-button ${songTransitionMode === "fade_out" ? "is-active" : ""}`}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick(
                    "action:set_song_transition_fade_out",
                    () => onSongTransitionModeChange("fade_out"),
                  )
                }
              >
                {t("timelineToolbar.songTransitionFadeOut")}
              </button>
            </div>
          </ControlGroup>

          {/* The Master gain control is hidden in compact view because
              each song column already exposes its own master fader at
              the top, making the toolbar control redundant. The Region
              transposition + Warp groups stay visible — those have no
              equivalent on the compact column header. */}
          {viewMode === "daw" ? (
          <ControlGroup
            title="Master"
            summary={masterSummary}
            open={openGroup === "master"}
            onToggleOpen={() =>
              setOpenGroup((current) =>
                current === "master" ? null : "master",
              )
            }
            className="lt-control-group-master"
            details={
              selectedRegion ? (
                <div className="lt-stepper-control-row lt-master-gain-row">
                  <RegionMasterFader
                    regionId={selectedRegion.id}
                    masterGain={masterGain}
                    disabled={masterControlsDisabled}
                    onChange={onSelectedRegionMasterGainChange}
                    onCommit={onSelectedRegionMasterGainCommit}
                  />
                  <button
                    type="button"
                    aria-label="Reset master gain to unity"
                    disabled={masterControlsDisabled}
                    onClick={() => onSelectedRegionMasterGainChange(1.0)}
                  >
                    0 dB
                  </button>
                </div>
              ) : (
                <span>{t("timelineToolbar.regionMasterNoSelection")}</span>
              )
            }
          />
          ) : null}

          <ControlGroup
            title={t("timelineToolbar.regionTransposeLabel")}
            summary={regionSummary}
            open={openGroup === "region"}
            onToggleOpen={() =>
              setOpenGroup((current) =>
                current === "region" ? null : "region",
              )
            }
            className="lt-control-group-region"
            details={
              selectedRegion ? (
                <label className="lt-stepper-control">
                  <span>{t("timelineToolbar.regionTransposeLabel")}</span>
                  <div className="lt-stepper-control-row">
                    <button
                      type="button"
                      aria-label={t("timelineToolbar.regionTransposeDownAria")}
                      disabled={regionControlsDisabled}
                      onClick={() => {
                        onSelectedRegionTransposeChange(
                          Math.max(-12, selectedRegion.transposeSemitones - 1),
                        );
                      }}
                    >
                      -
                    </button>
                    <input
                      aria-label={t("timelineToolbar.regionTransposeAria")}
                      type="number"
                      min={-12}
                      max={12}
                      step={1}
                      value={selectedRegion.transposeSemitones}
                      disabled={regionControlsDisabled}
                      onChange={(event) =>
                        onSelectedRegionTransposeChange(
                          Number(event.target.value) || 0,
                        )
                      }
                    />
                    <button
                      type="button"
                      aria-label={t("timelineToolbar.regionTransposeUpAria")}
                      disabled={regionControlsDisabled}
                      onClick={() => {
                        onSelectedRegionTransposeChange(
                          Math.min(12, selectedRegion.transposeSemitones + 1),
                        );
                      }}
                    >
                      +
                    </button>
                  </div>
                </label>
              ) : (
                <span>{t("timelineToolbar.regionTransposeNoSelection")}</span>
              )
            }
          />

          <ControlGroup
            title={t("timelineToolbar.regionWarpLabel")}
            summary={warpSummary}
            open={openGroup === "warp"}
            onToggleOpen={() =>
              setOpenGroup((current) => (current === "warp" ? null : "warp"))
            }
            className="lt-control-group-warp"
            details={
              selectedRegion ? (
                <>
                  <button
                    type="button"
                    className={`lt-vamp-button ${warpEnabled ? "is-active" : ""}`}
                    aria-label={t("timelineToolbar.regionWarpToggleAria")}
                    aria-pressed={warpEnabled}
                    disabled={warpControlsDisabled}
                    onClick={() => onSelectedRegionWarpToggle(!warpEnabled)}
                  >
                    {warpEnabled
                      ? t("timelineToolbar.regionWarpToggleOn")
                      : t("timelineToolbar.regionWarpToggleOff")}
                  </button>
                  <small className="lt-warp-semantics-hint">
                    {warpEnabled
                      ? t("timelineToolbar.regionWarpSemanticsOn")
                      : t("timelineToolbar.regionWarpSemanticsOff")}
                  </small>
                </>
              ) : (
                <span>{t("timelineToolbar.regionWarpNoSelection")}</span>
              )
            }
          />

          <button
            type="button"
            className={`lt-global-cancel-button ${pendingMarkerJumpLabel ? "is-warning" : ""}`}
            aria-label={t("timelineToolbar.cancelJump")}
            title={pendingMarkerJumpLabel ?? t("timelineToolbar.cancelJump")}
            disabled={!pendingMarkerJumpLabel && !learnModeActive}
            onClick={() => {
              if (learnModeActive) {
                onMidiLearnTarget("action:cancel_jump");
                return;
              }

              onCancelPendingJump();
            }}
          >
            <span className="material-symbols-outlined">close</span>
            <span>{t("timelineToolbar.cancelJump")}</span>
          </button>
        </div>
        <div className="lt-timeline-stats">
          <span>{t("timelineToolbar.tracksCount", { count: trackCount })}</span>
          <span>{t("timelineToolbar.clipsCount", { count: clipCount })}</span>
          <span>
            {t("timelineToolbar.markersCount", { count: markerCount })}
          </span>
        </div>
      </div>
    </div>
  );
}
