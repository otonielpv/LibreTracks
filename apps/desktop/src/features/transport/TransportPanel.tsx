import { useEffect, useState } from "react";
import {
  cancelSectionJump,
  getTransportSnapshot,
  isTauriApp,
  pauseTransport,
  pickAndImportSong,
  playTransport,
  scheduleSectionJump,
  seekTransport,
  stopTransport,
  type TransportSnapshot,
} from "./desktopApi";

export function TransportPanel() {
  const [snapshot, setSnapshot] = useState<TransportSnapshot | null>(null);
  const [status, setStatus] = useState("Cargando estado de la sesion...");
  const [isBusy, setIsBusy] = useState(false);

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
  const sections = song?.sections ?? [];
  const tracks = song?.tracks ?? [];
  const positionSeconds = snapshot?.positionSeconds ?? 0;
  const durationSeconds = song?.durationSeconds ?? 0;
  const currentSection = snapshot?.currentSection ?? null;
  const pendingJump = snapshot?.pendingSectionJump ?? null;

  const handleImport = async () => {
    setIsBusy(true);
    setStatus("Abriendo selector de archivos WAV...");

    try {
      const nextSnapshot = await pickAndImportSong();
      if (!nextSnapshot) {
        setStatus("Importacion cancelada.");
        return;
      }

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

  const handleScheduleJump = async (
    targetSectionId: string,
    trigger: "immediate" | "section_end" | "after_bars",
    bars?: number,
  ) => {
    try {
      const nextSnapshot = await scheduleSectionJump({ targetSectionId, trigger, bars });
      setSnapshot(nextSnapshot);
      setStatus(buildJumpStatus(nextSnapshot, trigger, bars));
    } catch (error) {
      setStatus(`No se pudo programar el salto: ${String(error)}`);
    }
  };

  const handleCancelJump = async () => {
    try {
      const nextSnapshot = await cancelSectionJump();
      setSnapshot(nextSnapshot);
      setStatus("Salto programado cancelado.");
    } catch (error) {
      setStatus(`No se pudo cancelar el salto: ${String(error)}`);
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
          <>
            <p className="status-meta">
              {formatClock(positionSeconds)} / {formatClock(durationSeconds)}
              {snapshot?.songDir ? ` • ${snapshot.songDir}` : ""}
            </p>
            <p className="status-meta">
              Seccion actual: <strong>{currentSection?.name ?? "Sin seccion activa"}</strong>
              {pendingJump
                ? ` • Salto pendiente: ${formatPendingJump(pendingJump.trigger)} a ${pendingJump.targetSectionName}`
                : ""}
            </p>
          </>
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
          <p>Importa WAVs y la cancion quedara lista para probar el transporte.</p>
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

          {sections.length > 0 && (
            <div className="sections-panel">
              <div className="sections-header">
                <div>
                  <h2>Secciones</h2>
                  <p>Programa saltos tipo Ableton sobre la rejilla musical de la cancion.</p>
                </div>
                <button disabled={!pendingJump} type="button" onClick={() => void handleCancelJump()}>
                  Cancelar salto
                </button>
              </div>

              <div className="section-list">
                {sections.map((section) => {
                  const isCurrent = currentSection?.id === section.id;
                  const isPending = pendingJump?.targetSectionId === section.id;

                  return (
                    <article className="section-row" key={section.id}>
                      <div className="section-meta">
                        <strong>
                          {section.name}
                          {isCurrent ? " • sonando" : ""}
                          {isPending ? " • pendiente" : ""}
                        </strong>
                        <span>
                          {formatClock(section.startSeconds)} - {formatClock(section.endSeconds)}
                        </span>
                      </div>

                      <div className="section-actions">
                        <button
                          disabled={isBusy}
                          type="button"
                          onClick={() => void handleScheduleJump(section.id, "immediate")}
                        >
                          Ahora
                        </button>
                        <button
                          disabled={isBusy}
                          type="button"
                          onClick={() => void handleScheduleJump(section.id, "section_end")}
                        >
                          Fin seccion
                        </button>
                        <button
                          disabled={isBusy}
                          type="button"
                          onClick={() => void handleScheduleJump(section.id, "after_bars", 2)}
                        >
                          2 compases
                        </button>
                        <button
                          disabled={isBusy}
                          type="button"
                          onClick={() => void handleScheduleJump(section.id, "after_bars", 4)}
                        >
                          4 compases
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

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

function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((totalSeconds % 1) * 1000);

  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
}

function formatPendingJump(trigger: string) {
  if (trigger === "section_end") {
    return "al final de la seccion";
  }

  if (trigger.startsWith("after_bars:")) {
    const bars = trigger.split(":")[1] ?? "0";
    return `en ${bars} compases`;
  }

  return "ahora";
}

function buildJumpStatus(
  snapshot: TransportSnapshot,
  trigger: "immediate" | "section_end" | "after_bars",
  bars?: number,
) {
  const target =
    snapshot.pendingSectionJump?.targetSectionName ??
    snapshot.currentSection?.name ??
    "la seccion";

  if (trigger === "immediate") {
    return `Salto inmediato ejecutado hacia ${target}.`;
  }

  if (trigger === "section_end") {
    return `Salto programado al final de la seccion hacia ${target}.`;
  }

  return `Salto programado a ${target} en la siguiente cuantizacion de ${bars ?? 4} compases.`;
}
