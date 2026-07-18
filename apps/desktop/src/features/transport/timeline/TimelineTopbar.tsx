import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";

import {
  getSongBaseBpm,
  isAndroidApp,
  type PlaybackState,
  type SongView,
} from "../desktopApi";
import { ResourceMeter } from "../panels/ResourceMeter";
import { AudioDeviceStatusBadge } from "../AudioDeviceStatusBadge";

type TimelineTopbarProps = {
  openTopMenu: "file" | null;
  menuBarRef: RefObject<HTMLDivElement | null>;
  canPersistProject: boolean;
  isProjectEmpty: boolean;
  tempoDraft: string;
  timeSignatureDraft: string;
  tempoSourceLabel: ReactNode;
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
  onCreateSongFromTemplate: () => void;
  onOpenProject: () => void;
  /** Android: opens the in-app sessions modal (create by name / open from
   * list) that replaces the dialog-based New/Open/Import menu entries. */
  onOpenMobileSessions: () => void;
  onImportSong: () => void;
  onImportSession: () => void;
  onExportSession: () => void;
  onImportExternalProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onSaveAsTemplate: () => void;
  onStopTransport: () => void;
  onPlayTransport: () => void;
  onPauseTransport: () => void;
  onNextSong: () => void;
  metronomeEnabled: boolean;
  onToggleMetronome: () => void;
  metronomeButtonRef?: React.Ref<HTMLButtonElement>;
  onOpenMetronome: () => void;
  isMetronomePopoverOpen: boolean;
  voiceGuideEnabled: boolean;
  onToggleVoiceGuide: () => void;
  voiceGuideButtonRef?: React.Ref<HTMLButtonElement>;
  onOpenVoiceGuide: () => void;
  isVoiceGuidePopoverOpen: boolean;
  padEnabled: boolean;
  padButtonRef?: React.Ref<HTMLButtonElement>;
  onTogglePads: () => void;
  onOpenPads: () => void;
  isPadsPopoverOpen: boolean;
  onTempoDraftChange: (nextTempoDraft: string) => void;
  onTempoDraftFocus?: () => void;
  onTapTempo: () => void;
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
  onCreateSongFromTemplate,
  onOpenProject,
  onOpenMobileSessions,
  onImportSong,
  onImportSession,
  onExportSession,
  onImportExternalProject,
  onSaveProject,
  onSaveProjectAs,
  onSaveAsTemplate,
  onStopTransport,
  onPlayTransport,
  onPauseTransport,
  onNextSong,
  metronomeEnabled,
  onToggleMetronome,
  metronomeButtonRef,
  onOpenMetronome,
  isMetronomePopoverOpen,
  voiceGuideEnabled,
  onToggleVoiceGuide,
  voiceGuideButtonRef,
  onOpenVoiceGuide,
  isVoiceGuidePopoverOpen,
  padEnabled,
  padButtonRef,
  onTogglePads,
  onOpenPads,
  isPadsPopoverOpen,
  onTempoDraftChange,
  onTempoDraftFocus,
  onTapTempo,
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
  const canOpenFileMenu = canPersistProject;

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

        {/* Android: no FILE menu here — its two mobile entries (Sessions…,
            Save) live in the side nav rail instead, so the transport strip
            gets the full width on narrow phone screens. */}
        {!isAndroidApp ? (
        <nav className="lt-menu-bar" aria-label={t("timelineTopbar.mainMenu")} ref={menuBarRef}>
          <div className={`lt-top-menu ${openTopMenu === "file" ? "is-open" : ""}`}>
            <button
              type="button"
              className="lt-top-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={canOpenFileMenu && openTopMenu === "file"}
              disabled={!canOpenFileMenu}
              onClick={() => {
                if (!canOpenFileMenu) {
                  return;
                }
                onToggleTopMenu("file");
              }}
            >
              <span className="lt-button-label">{t("timelineTopbar.fileMenu")}</span>
              <span className="material-symbols-outlined" aria-hidden="true">arrow_drop_down</span>
            </button>

            {canOpenFileMenu && openTopMenu === "file" && isAndroidApp ? (
              <div className="lt-top-menu-dropdown" role="menu" aria-label={t("timelineTopbar.fileMenu")}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onTopMenuAction(onOpenMobileSessions)}
                >
                  <span>
                    {t("timelineTopbar.mobileSessions", {
                      defaultValue: "Sesiones…",
                    })}
                  </span>
                </button>
                <div className="lt-top-menu-separator" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canPersistProject}
                  onClick={() => onTopMenuAction(onSaveProject)}
                >
                  <span>{t("timelineTopbar.save")}</span>
                </button>
              </div>
            ) : null}
            {canOpenFileMenu && openTopMenu === "file" && !isAndroidApp ? (
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
                  onClick={() => onTopMenuAction(onCreateSongFromTemplate)}
                >
                  <span>
                    {t("timelineTopbar.newFromTemplate", {
                      defaultValue: "Nuevo desde plantilla…",
                    })}
                  </span>
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
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onTopMenuAction(onImportSession)}
                >
                  <span>
                    {t("timelineTopbar.importSession", {
                      defaultValue: "Importar sesión…",
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canPersistProject && !learnModeActive}
                  onClick={() => onTopMenuAction(onExportSession)}
                >
                  <span>
                    {t("timelineTopbar.exportSession", {
                      defaultValue: "Exportar sesión…",
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (learnModeActive) {
                      onMidiLearnTarget("action:open_project");
                      return;
                    }
                    onTopMenuAction(onImportExternalProject);
                  }}
                >
                  <span>{t("timelineTopbar.importExternalProject")}</span>
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
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canPersistProject && !learnModeActive}
                  onClick={() => onTopMenuAction(onSaveAsTemplate)}
                >
                  <span>
                    {t("timelineTopbar.saveAsTemplate", {
                      defaultValue: "Guardar como plantilla…",
                    })}
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        </nav>
        ) : null}

        <ResourceMeter />
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
              onFocus={onTempoDraftFocus}
              onChange={(event) => onTempoDraftChange(event.target.value)}
              onBlur={onTempoCommit}
              onKeyDown={handleTempoKeyDown}
            />
            <small>{tempoSourceLabel}</small>
          </label>

          <button
            type="button"
            className="lt-tap-tempo-button"
            aria-label={t("timelineTopbar.tapTempo")}
            disabled={!song && !learnModeActive}
            onClick={() => {
              if (learnModeActive) {
                onMidiLearnTarget("param:tempo");
                return;
              }

              onTapTempo();
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">touch_app</span>
            <span>{t("timelineTopbar.tapTempoShort")}</span>
          </button>

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
            <div className="lt-topbar-split">
              <button
                type="button"
                ref={metronomeButtonRef}
                aria-label={t("timelineTopbar.metronome")}
                className={
                  metronomeEnabled
                    ? "is-active is-toggle lt-split-main"
                    : "is-toggle lt-split-main"
                }
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
                <span className="lt-button-label">
                  {t("timelineTopbar.click")}
                </span>
              </button>
              <button
                type="button"
                className={
                  isMetronomePopoverOpen
                    ? "is-toggle lt-split-caret is-open"
                    : "is-toggle lt-split-caret"
                }
                aria-label={t("timelineTopbar.metronomeSettings", {
                  defaultValue: "Ajustes del metrónomo",
                })}
                aria-expanded={isMetronomePopoverOpen}
                disabled={isProjectEmpty && !learnModeActive}
                onClick={onOpenMetronome}
              >
                <span className="material-symbols-outlined">
                  {isMetronomePopoverOpen ? "arrow_drop_up" : "arrow_drop_down"}
                </span>
              </button>
            </div>
            <div className="lt-topbar-split">
              <button
                type="button"
                ref={voiceGuideButtonRef}
                aria-label={t("timelineTopbar.voiceGuide")}
                className={
                  voiceGuideEnabled
                    ? "is-active is-toggle lt-split-main"
                    : "is-toggle lt-split-main"
                }
                disabled={isProjectEmpty && !learnModeActive}
                onClick={() => {
                  if (learnModeActive) {
                    onMidiLearnTarget("action:toggle_voice_guide");
                    return;
                  }

                  onToggleVoiceGuide();
                }}
              >
                <span className="material-symbols-outlined">campaign</span>
                <span className="lt-button-label">
                  {t("timelineTopbar.guide")}
                </span>
              </button>
              <button
                type="button"
                className={
                  isVoiceGuidePopoverOpen
                    ? "is-toggle lt-split-caret is-open"
                    : "is-toggle lt-split-caret"
                }
                aria-label={t("timelineTopbar.voiceGuideSettings", {
                  defaultValue: "Ajustes de la voz guía",
                })}
                aria-expanded={isVoiceGuidePopoverOpen}
                disabled={isProjectEmpty && !learnModeActive}
                onClick={onOpenVoiceGuide}
              >
                <span className="material-symbols-outlined">
                  {isVoiceGuidePopoverOpen ? "arrow_drop_up" : "arrow_drop_down"}
                </span>
              </button>
            </div>
            <div className="lt-topbar-split">
              <button
                type="button"
                ref={padButtonRef}
                aria-label={t("timelineTopbar.pads")}
                className={
                  padEnabled
                    ? "is-active is-toggle lt-split-main"
                    : "is-toggle lt-split-main"
                }
                disabled={isProjectEmpty && !learnModeActive}
                onClick={() => {
                  if (learnModeActive) {
                    onMidiLearnTarget("action:toggle_pads");
                    return;
                  }

                  onTogglePads();
                }}
              >
                <span className="material-symbols-outlined">graphic_eq</span>
                <span className="lt-button-label">{t("timelineTopbar.pads")}</span>
              </button>
              <button
                type="button"
                className={
                  isPadsPopoverOpen
                    ? "is-toggle lt-split-caret is-open"
                    : "is-toggle lt-split-caret"
                }
                aria-label={t("timelineTopbar.padsSettings", {
                  defaultValue: "Ajustes de los pads",
                })}
                aria-expanded={isPadsPopoverOpen}
                disabled={isProjectEmpty && !learnModeActive}
                onClick={onOpenPads}
              >
                <span className="material-symbols-outlined">
                  {isPadsPopoverOpen ? "arrow_drop_up" : "arrow_drop_down"}
                </span>
              </button>
            </div>
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
            <AudioDeviceStatusBadge />
          </div>
        </div>
      </div>
    </header>
  );
}
