import type { KeyboardEvent, RefObject } from "react";

import type { SongView } from "./desktopApi";

type TimelineTopbarProps = {
  openTopMenu: "file" | null;
  menuBarRef: RefObject<HTMLDivElement | null>;
  canPersistProject: boolean;
  isProjectEmpty: boolean;
  tempoDraft: string;
  tempoSourceLabel: string;
  song: SongView | null;
  musicalPositionLabel: string;
  readoutPositionSecondsLabel: string;
  playbackState: string;
  transportReadoutBarRef: RefObject<HTMLElement | null>;
  transportReadoutValueRef: RefObject<HTMLElement | null>;
  onToggleTopMenu: (menuKey: "file") => void;
  onTopMenuAction: (action: () => void) => void;
  onCreateSong: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onStopTransport: () => void;
  onPlayTransport: () => void;
  onPauseTransport: () => void;
  onTempoDraftChange: (nextTempoDraft: string) => void;
  onTempoCommit: () => void;
};

export function TimelineTopbar({
  openTopMenu,
  menuBarRef,
  canPersistProject,
  isProjectEmpty,
  tempoDraft,
  tempoSourceLabel,
  song,
  musicalPositionLabel,
  readoutPositionSecondsLabel,
  playbackState,
  transportReadoutBarRef,
  transportReadoutValueRef,
  onToggleTopMenu,
  onTopMenuAction,
  onCreateSong,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onStopTransport,
  onPlayTransport,
  onPauseTransport,
  onTempoDraftChange,
  onTempoCommit,
}: TimelineTopbarProps) {
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

        <nav className="lt-menu-bar" aria-label="Menu principal" ref={menuBarRef}>
          <div className={`lt-top-menu ${openTopMenu === "file" ? "is-open" : ""}`}>
            <button
              type="button"
              className="lt-top-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={openTopMenu === "file"}
              onClick={() => onToggleTopMenu("file")}
            >
              <span className="lt-button-label">Archivo</span>
              <span className="material-symbols-outlined" aria-hidden="true">arrow_drop_down</span>
            </button>

            {openTopMenu === "file" ? (
              <div className="lt-top-menu-dropdown" role="menu" aria-label="Archivo">
                <button type="button" role="menuitem" onClick={() => onTopMenuAction(onCreateSong)}>
                  <span>Nuevo proyecto</span>
                </button>
                <button type="button" role="menuitem" onClick={() => onTopMenuAction(onOpenProject)}>
                  <span>Abrir</span>
                </button>
                <div className="lt-top-menu-separator" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canPersistProject}
                  onClick={() => onTopMenuAction(onSaveProject)}
                >
                  <span>Guardar</span>
                  <span className="lt-top-menu-shortcut">Ctrl+S</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canPersistProject}
                  onClick={() => onTopMenuAction(onSaveProjectAs)}
                >
                  <span>Guardar como</span>
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
            <span>BPM</span>
            <input
              aria-label="BPM de la cancion"
              disabled={isProjectEmpty}
              type="number"
              min={1}
              step={0.1}
              value={tempoDraft}
              onChange={(event) => onTempoDraftChange(event.target.value)}
              onBlur={onTempoCommit}
              onKeyDown={handleTempoKeyDown}
            />
            <small title={song?.tempoMetadata.referenceFilePath ?? undefined}>{tempoSourceLabel}</small>
          </label>

          <div className="lt-transport-buttons">
            <button type="button" aria-label="Anterior" disabled={isProjectEmpty}>
              <span className="material-symbols-outlined">skip_previous</span>
            </button>
            <button type="button" aria-label="Detener" disabled={isProjectEmpty} onClick={onStopTransport}>
              <span className="material-symbols-outlined">stop</span>
            </button>
            <button type="button" aria-label="Reproducir" className="is-play" disabled={isProjectEmpty} onClick={onPlayTransport}>
              <span className="material-symbols-outlined">play_arrow</span>
            </button>
            <button type="button" aria-label="Pausar" disabled={isProjectEmpty} onClick={onPauseTransport}>
              <span className="material-symbols-outlined">pause</span>
            </button>
            <button type="button" aria-label="Siguiente" disabled={isProjectEmpty}>
              <span className="material-symbols-outlined">skip_next</span>
            </button>
          </div>

          <div className="lt-transport-readout">
            <div className="lt-readout-block">
              <span>Tempo</span>
              <strong>{song ? `${song.bpm.toFixed(2)} BPM` : "120.00 BPM"}</strong>
            </div>
            <div className="lt-readout-block">
              <span>Bar</span>
              <strong ref={transportReadoutBarRef}>{musicalPositionLabel}</strong>
            </div>
            <div className="lt-readout-block is-timecode">
              <span>Timecode</span>
              <strong ref={transportReadoutValueRef}>{readoutPositionSecondsLabel}</strong>
            </div>
            <span className={`transport-pill is-${playbackState}`}>{playbackState}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
