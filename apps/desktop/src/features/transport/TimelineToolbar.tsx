import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { formatTransposeSemitones, type SongRegionSummary } from "./desktopApi";
import type { GlobalJumpMode, SongJumpTrigger, SongTransitionMode, VampMode } from "./uiStore";

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
  onToggleSnap: () => void;
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
  /** Effective timeline BPM at the start of the selected region.
   *  Used by the warp panel to display the destination tempo and to
   *  auto-fill warpSourceBpm the first time warp is enabled. */
  selectedRegionEffectiveBpm: number;
  onSelectedRegionWarpToggle: (nextEnabled: boolean) => void;
  onSelectedRegionWarpSourceBpmChange: (nextSourceBpm: number) => void;
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
        {action ? <div className="lt-control-group-action">{action}</div> : null}
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
                {details ? <div className="lt-control-group-details">{details}</div> : null}
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
  onToggleSnap,
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
  onSelectedRegionWarpSourceBpmChange,
  midiLearnMode,
  onMidiLearnTarget,
}: TimelineToolbarProps) {
  const { t } = useTranslation();
  const learnModeActive = midiLearnMode !== null;
  const [openGroup, setOpenGroup] = useState<
    "jump" | "vamp" | "song" | "region" | "warp" | null
  >(null);
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
  // Display ratio uses Math.round on the source BPM only for the input default;
  // the live ratio is computed off the configured source and the timeline tempo.
  const warpRatio =
    warpEnabled && warpSourceBpm && warpSourceBpm > 0 && selectedRegionEffectiveBpm > 0
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
  // BPM field is only editable when warp is enabled (after toggle on, the
  // user can fine-tune the source BPM). When warp is off but a value was
  // persisted, we still show it but read-only via disabled state.
  const warpBpmInputDisabled = warpControlsDisabled || !warpEnabled;

  const handleModeButtonClick = (
    learnKey: string,
    commit: () => void,
  ) => {
    if (learnModeActive) {
      onMidiLearnTarget(learnKey);
      return;
    }

    commit();
  };

  return (
    <div className="lt-timeline-topline">
      <div className="lt-timeline-meta">
        <div className="lt-timeline-controls lt-bottom-controls">
          <button
            type="button"
            className={`lt-icon-button ${snapEnabled ? "is-active" : ""}`}
            aria-label={snapEnabled ? t("timelineToolbar.disableSnap") : t("timelineToolbar.enableSnap")}
            aria-pressed={snapEnabled}
            title={t("timelineToolbar.snapTitle", { subdivision: subdivisionPerBeat })}
            onClick={onToggleSnap}
          >
            <span className="material-symbols-outlined">{snapEnabled ? "grid_on" : "grid_off"}</span>
          </button>

          <ControlGroup
            title={t("timelineToolbar.vampModeLabel")}
            summary={vampMode === "bars" ? `${vampBars} bars` : t("timelineToolbar.vampSectionOption")}
            open={openGroup === "vamp"}
            onToggleOpen={() => setOpenGroup((current) => (current === "vamp" ? null : "vamp"))}
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
                        onChange={(event) => onVampBarsChange(Number(event.target.value) || 1)}
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
            <div className="lt-segmented-control" role="group" aria-label={t("timelineToolbar.vampModeAria")}>
              <button
                type="button"
                className={vampMode === "section" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() =>
                  handleModeButtonClick(
                    "action:set_vamp_mode_section",
                    () => onVampModeChange("section"),
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
                  handleModeButtonClick(
                    "action:set_vamp_mode_bars",
                    () => onVampModeChange("bars"),
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
            onToggleOpen={() => setOpenGroup((current) => (current === "jump" ? null : "jump"))}
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
                            onMidiLearnTarget("action:decrease_global_jump_bars");
                            return;
                          }

                          onGlobalJumpBarsChange(Math.max(1, globalJumpBars - 1));
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
                        onChange={(event) => onGlobalJumpBarsChange(Number(event.target.value) || 1)}
                      />
                      <button
                        type="button"
                        aria-label={t("timelineToolbar.markerBarsLabel")}
                        disabled={controlsDisabled}
                        onClick={() => {
                          if (learnModeActive) {
                            onMidiLearnTarget("action:increase_global_jump_bars");
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
                {pendingMarkerJumpLabel ? <span>{pendingMarkerJumpLabel}</span> : null}
              </>
            }
          >
            <div className="lt-segmented-control" role="group" aria-label={t("timelineToolbar.markerJumpModeAria")}>
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
            onToggleOpen={() => setOpenGroup((current) => (current === "song" ? null : "song"))}
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
                        onChange={(event) => onSongJumpBarsChange(Number(event.target.value) || 1)}
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
            <div className="lt-segmented-control" role="group" aria-label={t("timelineToolbar.songJumpModeAria")}>
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

          <ControlGroup
            title={t("timelineToolbar.regionTransposeLabel")}
            summary={regionSummary}
            open={openGroup === "region"}
            onToggleOpen={() => setOpenGroup((current) => (current === "region" ? null : "region"))}
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
                        onSelectedRegionTransposeChange(Math.max(-12, selectedRegion.transposeSemitones - 1));
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
                      onChange={(event) => onSelectedRegionTransposeChange(Number(event.target.value) || 0)}
                    />
                    <button
                      type="button"
                      aria-label={t("timelineToolbar.regionTransposeUpAria")}
                      disabled={regionControlsDisabled}
                      onClick={() => {
                        onSelectedRegionTransposeChange(Math.min(12, selectedRegion.transposeSemitones + 1));
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
            onToggleOpen={() => setOpenGroup((current) => (current === "warp" ? null : "warp"))}
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
                  <label className="lt-stepper-control">
                    <span>{t("timelineToolbar.regionWarpSourceBpmLabel")}</span>
                    <div className="lt-stepper-control-row">
                      <button
                        type="button"
                        aria-label={t("timelineToolbar.regionWarpSourceBpmDownAria")}
                        disabled={warpBpmInputDisabled}
                        onClick={() => {
                          const current = warpSourceBpm ?? selectedRegionEffectiveBpm;
                          onSelectedRegionWarpSourceBpmChange(Math.max(20, current - 1));
                        }}
                      >
                        -
                      </button>
                      <input
                        aria-label={t("timelineToolbar.regionWarpSourceBpmAria")}
                        type="number"
                        min={20}
                        max={300}
                        step={1}
                        value={warpSourceBpm ?? ""}
                        placeholder={selectedRegionEffectiveBpm.toFixed(0)}
                        disabled={warpBpmInputDisabled}
                        onChange={(event) => {
                          const parsed = Number(event.target.value);
                          if (!Number.isFinite(parsed) || parsed <= 0) return;
                          onSelectedRegionWarpSourceBpmChange(parsed);
                        }}
                      />
                      <button
                        type="button"
                        aria-label={t("timelineToolbar.regionWarpSourceBpmUpAria")}
                        disabled={warpBpmInputDisabled}
                        onClick={() => {
                          const current = warpSourceBpm ?? selectedRegionEffectiveBpm;
                          onSelectedRegionWarpSourceBpmChange(Math.min(300, current + 1));
                        }}
                      >
                        +
                      </button>
                    </div>
                  </label>
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
          <span>{t("timelineToolbar.markersCount", { count: markerCount })}</span>
        </div>
      </div>
    </div>
  );
}
