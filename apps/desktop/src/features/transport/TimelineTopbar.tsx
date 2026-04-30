import type { KeyboardEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";

import { getSongBaseBpm, type PlaybackState, type SongView } from "./desktopApi";

type TimelineTopbarProps = {
  openTopMenu: "file" | null;
  menuBarRef: RefObject<HTMLDivElement | null>;
  canPersistProject: boolean;
  isProjectEmpty: boolean;
  tempoDraft: string;
  timeSignatureDraft: string;
  tempoSourceLabel: string;
  displayedBpm: number;
  displayedTimeSignature: string;
  song: SongView | null;
  musicalPositionLabel: string;
  readoutPositionSecondsLabel: string;
  playbackState: PlaybackState;
  transportReadoutTempoRef: RefObject<HTMLElement | null>;
  transportReadoutBarRef: RefObject<HTMLElement | null>;
  transportReadoutValueRef: RefObject<HTMLElement | null>;
  onToggleTopMenu: (menuKey: "file") => void;
  onTopMenuAction: (action: () => void) => void;
  onCreateSong: () => void;
  onOpenProject: () => void;
  onImportSong: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onStopTransport: () => void;
  onPlayTransport: () => void;
  onPauseTransport: () => void;
  onNextSong: () => void;
  metronomeEnabled: boolean;
  onToggleMetronome: () => void;
  onTempoDraftChange: (nextTempoDraft: string) => void;
  onTempoCommit: () => void;
  onTimeSignatureDraftChange: (nextSignatureDraft: string) => void;
  onTimeSignatureCommit: () => void;
  midiLearnMode: string | null;
  onMidiLearnTarget: (controlKey: string) => void;
};

export function TimelineTopbar({
  openTopMenu,
  menuBarRef,
  canPersistProject,
  isProjectEmpty,
  tempoDraft,
  timeSignatureDraft,
  tempoSourceLabel,
  displayedBpm,
  displayedTimeSignature,
  song,
  musicalPositionLabel,
  readoutPositionSecondsLabel,
  playbackState,
  transportReadoutTempoRef,
  transportReadoutBarRef,
  transportReadoutValueRef,
  onToggleTopMenu,
  onTopMenuAction,
  onCreateSong,
  onOpenProject,
  onImportSong,
  onSaveProject,
  onSaveProjectAs,
  onStopTransport,
  onPlayTransport,
  onPauseTransport,
  onNextSong,
  metronomeEnabled,
  onToggleMetronome,
  onTempoDraftChange,
  onTempoCommit,
  onTimeSignatureDraftChange,
  onTimeSignatureCommit,
  midiLearnMode,
  onMidiLearnTarget,
}: TimelineTopbarProps) {
  const { t } = useTranslation();
  const fallbackBpm = getSongBaseBpm(song);
  const playbackStateLabel = t(`transport.playbackState.${playbackState}`);
  const learnModeActive = midiLearnMode !== null;

  const handleTempoKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }

    event.currentTarget.blur();
  };

  return (
    <header className="lt-topbar">
      <div className="lt-topbar-menu-row">
        <div className="lt-brand">
          <span className="lt-brand-title">LIBRETRACKS</span>
        </div>

        <nav className="lt-menu-bar" aria-label={t("timelineTopbar.mainMenu")} ref={menuBarRef}>
          <div className={`lt-top-menu ${openTopMenu === "file" ? "is-open" : ""}`}>
            <button
              type="button"
              className="lt-top-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={openTopMenu === "file"}
              onClick={() => onToggleTopMenu("file")}
            >
              <span className="lt-button-label">{t("timelineTopbar.fileMenu")}</span>
              <span className="material-symbols-outlined" aria-hidden="true">arrow_drop_down</span>
            </button>

            {openTopMenu === "file" ? (
              <div className="lt-top-menu-dropdown" role="menu" aria-label={t("timelineTopbar.fileMenu")}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (learnModeActive) {
                      onMidiLearnTarget("action:create_song");
                      return;
                    }
                    onTopMenuAction(onCreateSong);
                  }}
                >
                  <span>{t("timelineTopbar.newProject")}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (learnModeActive) {
                      onMidiLearnTarget("action:open_project");
                      return;
                    }
                    onTopMenuAction(onOpenProject);
                  }}
                >
                  <span>{t("timelineTopbar.open")}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (learnModeActive) {
                      onMidiLearnTarget("action:open_project");
                      return;
                    }
                    onTopMenuAction(onImportSong);
                  }}
                >
                  <span>{t("timelineTopbar.importSong")}</span>
                </button>
                <div className="lt-top-menu-separator" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canPersistProject && !learnModeActive}
                  onClick={() => {
                    if (learnModeActive) {
                      onMidiLearnTarget("action:save_project");
                      return;
                    }
                    onTopMenuAction(onSaveProject);
                  }}
                >
                  <span>{t("timelineTopbar.save")}</span>
                  <span className="lt-top-menu-shortcut">Ctrl+S</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canPersistProject && !learnModeActive}
                  onClick={() => {
                    if (learnModeActive) {
                      onMidiLearnTarget("action:save_project_as");
                      return;
                    }
                    onTopMenuAction(onSaveProjectAs);
                  }}
                >
                  <span>{t("timelineTopbar.saveAs")}</span>
                  <span className="lt-top-menu-shortcut">Ctrl+Shift+S</span>
                </button>
              </div>
            ) : null}
          </div>
        </nav>
      </div>

      <div className="lt-topbar-main-row">
        <div className="lt-transport">
          <label className="lt-bpm-control">
            <span>{t("timelineTopbar.bpmLabel")}</span>
            <input
              aria-label={t("timelineTopbar.songBpmAria")}
              disabled={!song}
              type="number"
              min={1}
              step={0.1}
              value={tempoDraft}
              onPointerDown={(event) => {
                if (!learnModeActive) {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();
                onMidiLearnTarget("param:tempo");
              }}
              onChange={(event) => onTempoDraftChange(event.target.value)}
              onBlur={onTempoCommit}
              onKeyDown={handleTempoKeyDown}
            />
            <small>{tempoSourceLabel}</small>
          </label>

          <label className="lt-bpm-control">
            <span>Compas</span>
            <input
              aria-label="Compas de la cancion"
              disabled={!song}
              type="text"
              value={timeSignatureDraft}
              onChange={(event) => onTimeSignatureDraftChange(event.target.value)}
              onBlur={onTimeSignatureCommit}
              onKeyDown={handleTempoKeyDown}
            />
            <small>{displayedTimeSignature}</small>
          </label>

          <div className="lt-transport-buttons">
            <button type="button" aria-label={t("timelineTopbar.previous")} disabled={isProjectEmpty}>
              <span className="material-symbols-outlined">skip_previous</span>
            </button>
            <button
              type="button"
              aria-label={t("timelineTopbar.stop")}
              disabled={isProjectEmpty && !learnModeActive}
              onClick={() => {
                if (learnModeActive) {
                  onMidiLearnTarget("action:stop");
                  return;
                }

                onStopTransport();
              }}
            >
              <span className="material-symbols-outlined">stop</span>
            </button>
            <button
              type="button"
              aria-label={t("timelineTopbar.play")}
              className="is-play"
              disabled={isProjectEmpty && !learnModeActive}
              onClick={() => {
                if (learnModeActive) {
                  onMidiLearnTarget("action:play");
                  return;
                }

                onPlayTransport();
              }}
            >
              <span className="material-symbols-outlined">play_arrow</span>
            </button>
            <button
              type="button"
              aria-label={t("timelineTopbar.pause")}
              disabled={isProjectEmpty && !learnModeActive}
              onClick={() => {
                if (learnModeActive) {
                  onMidiLearnTarget("action:pause");
                  return;
                }

                onPauseTransport();
              }}
            >
              <span className="material-symbols-outlined">pause</span>
            </button>
            <button
              type="button"
              aria-label={t("timelineTopbar.metronome")}
              className={metronomeEnabled ? "is-active is-toggle" : "is-toggle"}
              disabled={isProjectEmpty && !learnModeActive}
              onClick={() => {
                if (learnModeActive) {
                  onMidiLearnTarget("action:toggle_metronome");
                  return;
                }

                onToggleMetronome();
              }}
            >
              <span className="material-symbols-outlined">music_note</span>
              <span className="lt-button-label">{t("timelineTopbar.click")}</span>
            </button>
            <button
              type="button"
              aria-label={t("timelineTopbar.next")}
              disabled={isProjectEmpty && !learnModeActive}
              onClick={() => {
                if (learnModeActive) {
                  onMidiLearnTarget("action:next_song");
                  return;
                }

                onNextSong();
              }}
            >
              <span className="material-symbols-outlined">skip_next</span>
            </button>
          </div>

          <div className="lt-transport-readout">
            <div className="lt-readout-block">
              <span>{t("timelineTopbar.tempoReadout")}</span>
              <strong ref={transportReadoutTempoRef}>{`${(Number.isFinite(displayedBpm) ? displayedBpm : fallbackBpm).toFixed(2)} BPM`}</strong>
            </div>
            <div className="lt-readout-block">
              <span>Compas</span>
              <strong>{displayedTimeSignature}</strong>
            </div>
            <div className="lt-readout-block">
              <span>{t("timelineTopbar.barReadout")}</span>
              <strong ref={transportReadoutBarRef}>{musicalPositionLabel}</strong>
            </div>
            <div className="lt-readout-block is-timecode">
              <span>{t("timelineTopbar.timecodeReadout")}</span>
              <strong ref={transportReadoutValueRef}>{readoutPositionSecondsLabel}</strong>
            </div>
            <span className={`transport-pill is-${playbackState}`}>{playbackStateLabel}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
