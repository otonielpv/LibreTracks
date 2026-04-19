import { useEffect, useState } from "react";
import {
  getTransportSnapshot,
  isTauriApp,
  pauseTransport,
  pickAndImportSong,
  playTransport,
  seekTransport,
  stopTransport,
  type ClipSummary,
  type TransportSnapshot,
} from "./desktopApi";

export function TransportPanel() {
  const [snapshot, setSnapshot] = useState<TransportSnapshot | null>(null);
  const [status, setStatus] = useState("Cargando estado de la sesion...");
  const [isBusy, setIsBusy] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1.5);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadInitialState() {
      const nextSnapshot = await getTransportSnapshot();
      if (!active) {
        return;
      }

      setSnapshot(nextSnapshot);
      setStatus(
        nextSnapshot.isNativeRuntime
          ? "Modo escritorio nativo listo para importar WAVs."
          : "Modo demo web: la reproduccion real se prueba con Tauri.",
      );
    }

    void loadInitialState();

    if (!isTauriApp) {
      return () => {
        active = false;
      };
    }

    const interval = window.setInterval(async () => {
      const nextSnapshot = await getTransportSnapshot();
      if (!active) {
        return;
      }

      setSnapshot(nextSnapshot);
    }, 350);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const song = snapshot?.song ?? null;
  const groups = song?.groups ?? [];
  const tracks = song?.tracks ?? [];
  const clips = song?.clips ?? [];
  const positionSeconds = snapshot?.positionSeconds ?? 0;
  const durationSeconds = song?.durationSeconds ?? 0;
  const cursorPercent = durationSeconds > 0 ? (positionSeconds / durationSeconds) * 100 : 0;
  const rulerMarks = buildRulerMarks(durationSeconds, zoomLevel);
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;

  useEffect(() => {
    if (!selectedClipId) {
      return;
    }

    const selectedClipStillExists = clips.some((clip) => clip.id === selectedClipId);
    if (!selectedClipStillExists) {
      setSelectedClipId(null);
    }
  }, [clips, selectedClipId]);

  const handleImport = async () => {
    setIsBusy(true);
    setStatus("Abriendo selector de archivos WAV...");

    try {
      const nextSnapshot = await pickAndImportSong();
      if (!nextSnapshot) {
        setStatus("Importacion cancelada.");
        return;
      }

      setSelectedClipId(null);
      setSnapshot(nextSnapshot);
      setStatus(
        `Cancion cargada: ${nextSnapshot.song?.title ?? "Sin titulo"}. Ya puedes pulsar Play.`,
      );
    } catch (error) {
      setStatus(`No se pudo importar la cancion: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handlePlay = async () => {
    try {
      const nextSnapshot = await playTransport();
      setSnapshot(nextSnapshot);
      setStatus("Reproduccion en curso.");
    } catch (error) {
      setStatus(`No se pudo reproducir: ${String(error)}`);
    }
  };

  const handlePause = async () => {
    try {
      const nextSnapshot = await pauseTransport();
      setSnapshot(nextSnapshot);
      setStatus("Reproduccion pausada.");
    } catch (error) {
      setStatus(`No se pudo pausar: ${String(error)}`);
    }
  };

  const handleStop = async () => {
    try {
      const nextSnapshot = await stopTransport();
      setSnapshot(nextSnapshot);
      setStatus("Reproduccion detenida.");
    } catch (error) {
      setStatus(`No se pudo detener: ${String(error)}`);
    }
  };

  const handleSeek = async (position: number) => {
    try {
      const nextSnapshot = await seekTransport(position);
      setSnapshot(nextSnapshot);
    } catch (error) {
      setStatus(`No se pudo mover el transporte: ${String(error)}`);
    }
  };

  return (
    <section className="panel">
      <div className="transport">
        <button disabled={!song || isBusy} type="button" onClick={() => void handlePlay()}>
          Play
        </button>
        <button disabled={!song || isBusy} type="button" onClick={() => void handlePause()}>
          Pause
        </button>
        <button disabled={!song || isBusy} type="button" onClick={() => void handleStop()}>
          Stop
        </button>
        <strong>{formatClock(positionSeconds)}</strong>
        <span className="transport-state">{snapshot?.playbackState ?? "empty"}</span>
      </div>

      <div className="status-box">
        <strong>{song?.title ?? "Todavia no hay cancion cargada"}</strong>
        <p>{status}</p>
        {song && (
          <p className="status-meta">
            {formatClock(positionSeconds)} / {formatClock(durationSeconds)}
            {snapshot?.songDir ? ` • ${snapshot.songDir}` : ""}
          </p>
        )}
      </div>

      {groups.length > 0 && (
        <div className="group-list">
          {groups.map((group) => (
            <article className="group-row" key={group.id}>
              <div>
                <h3>{group.name}</h3>
                <p>Vol {Math.round(group.volume * 100)}%</p>
              </div>
              <div className="row-controls">
                <label className="slider-field">
                  <span>Volumen</span>
                  <input
                    aria-label={`Volumen de grupo ${group.name}`}
                    disabled
                    max="100"
                    min="0"
                    type="range"
                    value={Math.round(group.volume * 100)}
                    onChange={() => undefined}
                  />
                </label>
                <button disabled type="button">
                  {group.muted ? "Unmute" : "Mute"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="track-header">
        <div>
          <h2>Tracks</h2>
          <p>Importa WAVs y la cancion quedara lista para probar transporte y timeline.</p>
        </div>
        <div className="track-actions">
          <button disabled={!isTauriApp || isBusy} type="button">
            Crear Cancion
          </button>
          <button disabled={!isTauriApp || isBusy} type="button" onClick={() => void handleImport()}>
            Importar WAVs
          </button>
          <button disabled type="button">
            Abrir Proyecto
          </button>
        </div>
      </div>

      {song ? (
        <>
          <div className="seek-box">
            <label className="seek-field">
              <span>Posicion</span>
              <input
                aria-label="Posicion del transporte"
                max={Math.max(durationSeconds, 0)}
                min="0"
                step="0.01"
                type="range"
                value={positionSeconds}
                onChange={(event) => {
                  const nextPosition = Number(event.target.value);
                  void handleSeek(nextPosition);
                }}
              />
            </label>
          </div>

          <section className="timeline-panel">
            <div className="timeline-head">
              <div>
                <h2>Timeline</h2>
                <p>Primera vista DAW: regla temporal, pistas verticales, clips, zoom y cursor.</p>
              </div>
              <div className="timeline-tools">
                <label className="zoom-field">
                  <span>Zoom</span>
                  <input
                    aria-label="Zoom horizontal del timeline"
                    max="4"
                    min="1"
                    step="0.5"
                    type="range"
                    value={zoomLevel}
                    onChange={(event) => {
                      setZoomLevel(Number(event.target.value));
                    }}
                  />
                </label>
                <strong className="timeline-meta">
                  {tracks.length} pistas • {zoomLevel.toFixed(1)}x
                </strong>
              </div>
            </div>

            <div className="clip-inspector" role="status">
              {selectedClip ? (
                <>
                  <strong>Clip seleccionado: {selectedClip.trackName}</strong>
                  <p>
                    Inicio {formatClock(selectedClip.timelineStartSeconds)} • Duracion{" "}
                    {formatClock(selectedClip.durationSeconds)} • Gain{" "}
                    {Math.round(selectedClip.gain * 100)}%
                  </p>
                </>
              ) : (
                <>
                  <strong>No hay clip seleccionado</strong>
                  <p>Haz click en un clip del timeline para inspeccionarlo.</p>
                </>
              )}
            </div>

            <div className="timeline-scroll">
              <div className="timeline-content" style={{ width: `${Math.max(zoomLevel * 100, 100)}%` }}>
                <div className="timeline-ruler">
                  {rulerMarks.map((mark) => (
                    <div className="ruler-mark" key={mark.seconds} style={{ left: `${mark.percent}%` }}>
                      <span>{mark.label}</span>
                    </div>
                  ))}
                </div>

                <div className="timeline-body">
                  <div className="timeline-cursor" style={{ left: `${cursorPercent}%` }} />

                  {tracks.map((track) => (
                    <article className="timeline-row" key={track.id}>
                      <div className="timeline-track">
                        <strong>{track.name}</strong>
                        <span>{track.groupName ?? "Sin grupo"}</span>
                      </div>

                      <div className="timeline-lane">
                        {clips
                          .filter((clip) => clip.trackId === track.id)
                          .map((clip) => (
                            <button
                              aria-label={`Clip ${clip.trackName}`}
                              aria-pressed={selectedClipId === clip.id}
                              className={`clip-block${selectedClipId === clip.id ? " is-selected" : ""}`}
                              key={clip.id}
                              style={clipStyle(clip, durationSeconds)}
                              title={`${clip.trackName} • ${formatClock(
                                clip.timelineStartSeconds,
                              )} / ${formatClock(clip.durationSeconds)}`}
                              type="button"
                              onClick={() => {
                                setSelectedClipId(clip.id);
                              }}
                            >
                              <div className="clip-waveform" aria-hidden="true">
                                {clip.waveformPeaks.length > 0 ? (
                                  clip.waveformPeaks.map((peak, index) => (
                                    <span
                                      className="waveform-bar"
                                      key={`${clip.id}-${index}`}
                                      style={{ height: `${Math.max(peak * 100, 6)}%` }}
                                    />
                                  ))
                                ) : (
                                  <span className="waveform-empty" />
                                )}
                              </div>
                            </button>
                          ))}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <div className="track-list">
            {tracks.map((track) => (
              <article className="track-row" key={track.id}>
                <div className="track-meta">
                  <strong>{track.name}</strong>
                  <span>{track.groupName ?? "Sin grupo"}</span>
                </div>

                <label className="slider-field track-slider">
                  <span>Vol {Math.round(track.volume * 100)}%</span>
                  <input
                    aria-label={`Volumen de pista ${track.name}`}
                    disabled
                    max="100"
                    min="0"
                    type="range"
                    value={Math.round(track.volume * 100)}
                    onChange={() => undefined}
                  />
                </label>

                <button disabled type="button">
                  {track.muted ? "Unmute" : "Mute"}
                </button>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <p>
            Usa <strong>Importar WAVs</strong> desde la app Tauri para seleccionar una o varias
            pistas. Se copiaran a la carpeta interna del proyecto y podras escucharlas con{" "}
            <strong>Play</strong>.
          </p>
        </div>
      )}
    </section>
  );
}

function clipStyle(clip: ClipSummary, durationSeconds: number) {
  const safeDuration = Math.max(durationSeconds, 0.001);
  const left = (clip.timelineStartSeconds / safeDuration) * 100;
  const width = Math.max((clip.durationSeconds / safeDuration) * 100, 1.5);

  return {
    left: `${left}%`,
    width: `${width}%`,
  };
}

function buildRulerMarks(durationSeconds: number, zoomLevel: number) {
  const safeDuration = Math.max(durationSeconds, 1);
  const markCount = Math.max(8, Math.round(8 * zoomLevel));

  return Array.from({ length: markCount + 1 }, (_, index) => {
    const seconds = (safeDuration / markCount) * index;

    return {
      seconds,
      percent: (seconds / safeDuration) * 100,
      label: formatTimelineMark(seconds),
    };
  });
}

function formatTimelineMark(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((totalSeconds % 1) * 1000);

  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
}
