import { useTranslation } from "react-i18next";

import type { GlobalJumpMode, SongJumpTrigger, SongTransitionMode, VampMode } from "./uiStore";

type TimelineToolbarProps = {
  snapEnabled: boolean;
  subdivisionPerBeat: number;
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
  midiLearnMode: string | null;
  onMidiLearnTarget: (controlKey: string) => void;
};

export function TimelineToolbar({
  snapEnabled,
  subdivisionPerBeat,
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
  midiLearnMode,
  onMidiLearnTarget,
}: TimelineToolbarProps) {
  const { t } = useTranslation();
  const learnModeActive = midiLearnMode !== null;

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
        <div className="lt-bottom-controls lt-timeline-controls">
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
          <div className="lt-zoom-control lt-jump-mode-control">
            <span>{t("timelineToolbar.markerJumpLabel")}</span>
            <div className="lt-segmented-control" role="group" aria-label={t("timelineToolbar.markerJumpModeAria")}>
              <button
                type="button"
                className={globalJumpMode === "immediate" ? "is-active" : ""}
                disabled={isProjectEmpty && !learnModeActive}
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
                disabled={isProjectEmpty && !learnModeActive}
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
                disabled={isProjectEmpty && !learnModeActive}
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
          </div>
          {globalJumpMode === "after_bars" ? (
            <label className="lt-zoom-control lt-stepper-control">
              <span>{t("timelineToolbar.markerBarsLabel")}</span>
              <div className="lt-stepper-control-row">
                <button
                  type="button"
                  aria-label={t("timelineToolbar.markerBarsLabel")}
                  disabled={isProjectEmpty && !learnModeActive}
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
                  disabled={isProjectEmpty && !learnModeActive}
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
          <div className="lt-zoom-control lt-jump-mode-control">
            <span>{t("timelineToolbar.vampModeLabel")}</span>
            <div className="lt-segmented-control" role="group" aria-label={t("timelineToolbar.vampModeAria")}>
              <button
                type="button"
                className={vampMode === "section" ? "is-active" : ""}
                disabled={isProjectEmpty && !learnModeActive}
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
                disabled={isProjectEmpty && !learnModeActive}
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
          </div>
          {vampMode === "bars" ? (
            <label className="lt-zoom-control lt-stepper-control">
              <span>{t("timelineToolbar.vampBarsLabel")}</span>
              <div className="lt-stepper-control-row">
                <button
                  type="button"
                  aria-label={t("timelineToolbar.vampBarsAria")}
                  disabled={isProjectEmpty && !learnModeActive}
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
                  disabled={isProjectEmpty && !learnModeActive}
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
          <button
            type="button"
            className={`lt-vamp-button ${isVampActive ? "is-active" : ""}`}
            aria-label={t("timelineToolbar.vampToggle")}
            disabled={isProjectEmpty && !learnModeActive}
            onClick={() => {
              if (learnModeActive) {
                onMidiLearnTarget("action:toggle_vamp");
                return;
              }

              onToggleVamp();
            }}
          >
            {t("timelineToolbar.vampButton")}
          </button>
          <div className="lt-zoom-control lt-jump-mode-control">
            <span>{t("timelineToolbar.songJumpLabel")}</span>
            <div className="lt-segmented-control" role="group" aria-label={t("timelineToolbar.songJumpModeAria")}>
              <button
                type="button"
                className={songJumpTrigger === "immediate" ? "is-active" : ""}
                disabled={isProjectEmpty && !learnModeActive}
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
                disabled={isProjectEmpty && !learnModeActive}
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
                disabled={isProjectEmpty && !learnModeActive}
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
          </div>
          {songJumpTrigger === "after_bars" ? (
            <label className="lt-zoom-control lt-stepper-control">
              <span>{t("timelineToolbar.songBarsLabel")}</span>
              <div className="lt-stepper-control-row">
                <button
                  type="button"
                  aria-label={t("timelineToolbar.songJumpBarsAria")}
                  disabled={isProjectEmpty && !learnModeActive}
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
                  disabled={isProjectEmpty && !learnModeActive}
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
          <div className="lt-zoom-control lt-jump-mode-control">
            <span>{t("timelineToolbar.songTransitionLabel")}</span>
            <div className="lt-segmented-control" role="group" aria-label={t("timelineToolbar.songTransitionAria")}>
              <button
                type="button"
                className={songTransitionMode === "instant" ? "is-active" : ""}
                disabled={isProjectEmpty && !learnModeActive}
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
                className={songTransitionMode === "fade_out" ? "is-active" : ""}
                disabled={isProjectEmpty && !learnModeActive}
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
          </div>
          {pendingMarkerJumpLabel ? <span>{pendingMarkerJumpLabel}</span> : null}
          <button
            type="button"
            className="lt-icon-button"
            aria-label={t("timelineToolbar.cancelJump")}
            title={t("timelineToolbar.cancelJump")}
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
