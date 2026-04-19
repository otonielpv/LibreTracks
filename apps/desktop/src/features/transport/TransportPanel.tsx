import { useEffect, useRef, useState } from "react";
import {
  createSection,
  createSong,
  getTransportSnapshot,
  isTauriApp,
  moveClip,
  openProject,
  pauseTransport,
  pickAndImportSong,
  playTransport,
  saveProject,
  seekTransport,
  stopTransport,
  type ClipSummary,
  type SectionSummary,
  type TransportSnapshot,
} from "./desktopApi";

type TimelineDragState =
  | {
      mode: "seek" | "section";
      pointerId: number;
      startSeconds: number;
      currentSeconds: number;
    }
  | null;

type SectionDraft = {
  startSeconds: number;
  endSeconds: number;
};

export function TransportPanel() {
  const [snapshot, setSnapshot] = useState<TransportSnapshot | null>(null);
  const [status, setStatus] = useState("Cargando estado de la sesion...");
  const [isBusy, setIsBusy] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1.5);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [clipStartDraft, setClipStartDraft] = useState("0.00");
  const [sectionSelectionMode, setSectionSelectionMode] = useState(false);
  const [sectionDraft, setSectionDraft] = useState<SectionDraft | null>(null);
  const [timelineDrag, setTimelineDrag] = useState<TimelineDragState>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineContentRef = useRef<HTMLDivElement | null>(null);

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
  const sections = song?.sections ?? [];
  const positionSeconds = snapshot?.positionSeconds ?? 0;
  const durationSeconds = song?.durationSeconds ?? 0;
  const displayedPositionSeconds =
    timelineDrag?.mode === "seek" ? timelineDrag.currentSeconds : positionSeconds;
  const cursorPercent = durationSeconds > 0 ? (displayedPositionSeconds / durationSeconds) * 100 : 0;
  const rulerMarks = buildRulerMarks(durationSeconds, zoomLevel);
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;
  const currentSection = snapshot?.currentSection ?? null;
  const pendingSectionJump = snapshot?.pendingSectionJump ?? null;
  const activeSectionDraft =
    timelineDrag?.mode === "section"
      ? normalizeRange(timelineDrag.startSeconds, timelineDrag.currentSeconds)
      : sectionDraft;

  useEffect(() => {
    if (!selectedClipId) {
      return;
    }

    const selectedClipStillExists = clips.some((clip) => clip.id === selectedClipId);
    if (!selectedClipStillExists) {
      setSelectedClipId(null);
    }
  }, [clips, selectedClipId]);

  useEffect(() => {
    if (!selectedClip) {
      setClipStartDraft("0.00");
      return;
    }

    setClipStartDraft(selectedClip.timelineStartSeconds.toFixed(2));
  }, [selectedClip]);

  const resetEditorSelections = () => {
    setSelectedClipId(null);
    setSectionDraft(null);
    setTimelineDrag(null);
  };

  const handleCreateSong = async () => {
    setIsBusy(true);
    setStatus("Creando una nueva cancion vacia...");

    try {
      const nextSnapshot = await createSong();
      setSnapshot(nextSnapshot);
      resetEditorSelections();
      setStatus(`Proyecto creado: ${nextSnapshot.song?.title ?? "Nueva Cancion"}.`);
    } catch (error) {
      setStatus(`No se pudo crear la cancion: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveProject = async () => {
    setIsBusy(true);
    setStatus("Guardando proyecto...");

    try {
      const nextSnapshot = await saveProject();
      setSnapshot(nextSnapshot);
      setStatus(`Proyecto guardado${nextSnapshot.songDir ? ` en ${nextSnapshot.songDir}` : ""}.`);
    } catch (error) {
      setStatus(`No se pudo guardar el proyecto: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleOpenProject = async () => {
    setIsBusy(true);
    setStatus("Abriendo proyecto...");

    try {
      const nextSnapshot = await openProject();
      if (!nextSnapshot) {
        setStatus("Apertura cancelada.");
        return;
      }

      setSnapshot(nextSnapshot);
      resetEditorSelections();
      setStatus(`Proyecto abierto: ${nextSnapshot.song?.title ?? "Sin titulo"}.`);
    } catch (error) {
      setStatus(`No se pudo abrir el proyecto: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

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
      resetEditorSelections();
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
      setStatus(`Cursor movido a ${formatClock(position)}.`);
    } catch (error) {
      setStatus(`No se pudo mover el transporte: ${String(error)}`);
    }
  };

  const handleMoveSelectedClip = async (nextTimelineStartSeconds: number) => {
    if (!selectedClip) {
      return;
    }

    setIsBusy(true);

    try {
      const nextSnapshot = await moveClip(selectedClip.id, nextTimelineStartSeconds);
      setSnapshot(nextSnapshot);
      setStatus(
        `${clipDisplayName(selectedClip)} movido a ${formatClock(
          Math.max(0, nextTimelineStartSeconds),
        )}.`,
      );
    } catch (error) {
      setStatus(`No se pudo mover el clip: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleApplyClipStart = async () => {
    if (!selectedClip) {
      return;
    }

    const parsedStart = Number(clipStartDraft);
    if (Number.isNaN(parsedStart)) {
      setStatus("La nueva posicion del clip no es valida.");
      return;
    }

    await handleMoveSelectedClip(parsedStart);
  };

  const handleCreateSection = async () => {
    if (!activeSectionDraft) {
      return;
    }

    setIsBusy(true);

    try {
      const nextSnapshot = await createSection(activeSectionDraft);
      setSnapshot(nextSnapshot);
      setSectionDraft(null);
      setSectionSelectionMode(false);
      setStatus(
        `Seccion creada de ${formatClock(activeSectionDraft.startSeconds)} a ${formatClock(
          activeSectionDraft.endSeconds,
        )}.`,
      );
    } catch (error) {
      setStatus(`No se pudo crear la seccion: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const resolveTimelineSeconds = (clientX: number) => {
    const scrollElement = timelineScrollRef.current;
    const contentElement = timelineContentRef.current;
    if (!scrollElement || !contentElement || durationSeconds <= 0) {
      return 0;
    }

    const rect = scrollElement.getBoundingClientRect();
    const contentWidth =
      contentElement.getBoundingClientRect().width || contentElement.scrollWidth || rect.width || 1;
    const relativeX = clientX - rect.left + scrollElement.scrollLeft;
    const ratio = clamp(relativeX / contentWidth, 0, 1);
    return ratio * durationSeconds;
  };

  const handleTimelinePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!song || durationSeconds <= 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest(".clip-block")) {
      return;
    }

    const nextSeconds = resolveTimelineSeconds(event.clientX);
    event.currentTarget.setPointerCapture(event.pointerId);
    setTimelineDrag({
      mode: sectionSelectionMode ? "section" : "seek",
      pointerId: event.pointerId,
      startSeconds: nextSeconds,
      currentSeconds: nextSeconds,
    });
  };

  const handleTimelinePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    setTimelineDrag((currentDrag) => {
      if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
        return currentDrag;
      }

      return {
        ...currentDrag,
        currentSeconds: resolveTimelineSeconds(event.clientX),
      };
    });
  };

  const handleTimelinePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const currentDrag = timelineDrag;
    if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    setTimelineDrag(null);

    if (currentDrag.mode === "seek") {
      void handleSeek(currentDrag.currentSeconds);
      return;
    }

    setSectionDraft(normalizeRange(currentDrag.startSeconds, currentDrag.currentSeconds));
  };

  const handleTimelinePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!timelineDrag || timelineDrag.pointerId !== event.pointerId) {
      return;
    }

    setTimelineDrag(null);
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
        <strong>{formatClock(displayedPositionSeconds)}</strong>
        <span className="transport-state">{snapshot?.playbackState ?? "empty"}</span>
      </div>

      <div className="status-box">
        <strong>{song?.title ?? "Todavia no hay cancion cargada"}</strong>
        <p>{status}</p>
        {song && (
          <p className="status-meta">
            {formatClock(positionSeconds)} / {formatClock(durationSeconds)}
            {snapshot?.songDir ? ` | ${snapshot.songDir}` : ""}
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
          <p>
            Crea, abre o importa proyectos; luego mueve el cursor directamente sobre el timeline.
          </p>
        </div>
        <div className="track-actions">
          <button disabled={isBusy} type="button" onClick={() => void handleCreateSong()}>
            Crear Cancion
          </button>
          <button disabled={isBusy} type="button" onClick={() => void handleImport()}>
            Importar WAVs
          </button>
          <button disabled={!song || isBusy} type="button" onClick={() => void handleSaveProject()}>
            Guardar Proyecto
          </button>
          <button disabled={isBusy} type="button" onClick={() => void handleOpenProject()}>
            Abrir Proyecto
          </button>
        </div>
      </div>

      {song ? (
        <>
          <section className="timeline-panel">
            <div className="timeline-head">
              <div>
                <h2>Timeline</h2>
                <p>
                  Cursor y secciones sobre la propia linea de tiempo: click y arrastre para mover o
                  seleccionar.
                </p>
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
                <button
                  aria-pressed={sectionSelectionMode}
                  className={sectionSelectionMode ? "mode-toggle is-active" : "mode-toggle"}
                  disabled={isBusy}
                  type="button"
                  onClick={() => {
                    setSectionSelectionMode((currentValue) => !currentValue);
                    setTimelineDrag(null);
                  }}
                >
                  {sectionSelectionMode ? "Modo seccion activo" : "Modo seccion"}
                </button>
                <strong className="timeline-meta">
                  {tracks.length} pistas | {zoomLevel.toFixed(1)}x
                </strong>
              </div>
            </div>

            <div className="timeline-status-grid">
              <div className="clip-inspector" role="status">
                {selectedClip ? (
                  <>
                    <strong>Clip seleccionado: {clipDisplayName(selectedClip)}</strong>
                    <p>
                      Inicio {formatClock(selectedClip.timelineStartSeconds)} | Duracion{" "}
                      {formatClock(selectedClip.durationSeconds)} | Gain{" "}
                      {Math.round(selectedClip.gain * 100)}%
                    </p>
                    <div className="clip-inspector-tools">
                      <label className="clip-start-field">
                        <span>Inicio timeline (s)</span>
                        <input
                          aria-label="Inicio del clip en segundos"
                          disabled={isBusy}
                          min="0"
                          step="0.01"
                          type="number"
                          value={clipStartDraft}
                          onChange={(event) => {
                            setClipStartDraft(event.target.value);
                          }}
                        />
                      </label>
                      <div className="clip-nudge-actions">
                        <button
                          disabled={isBusy}
                          type="button"
                          onClick={() => {
                            void handleMoveSelectedClip(selectedClip.timelineStartSeconds - 1);
                          }}
                        >
                          -1s
                        </button>
                        <button
                          disabled={isBusy}
                          type="button"
                          onClick={() => {
                            void handleMoveSelectedClip(selectedClip.timelineStartSeconds + 1);
                          }}
                        >
                          +1s
                        </button>
                        <button disabled={isBusy} type="button" onClick={() => void handleApplyClipStart()}>
                          Aplicar
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <strong>No hay clip seleccionado</strong>
                    <p>Haz click en un clip del timeline para inspeccionarlo.</p>
                  </>
                )}
              </div>

              <div className="timeline-context">
                <div className="timeline-context-card">
                  <strong>Seccion actual</strong>
                  <p>{currentSection ? currentSection.name : "Sin seccion activa"}</p>
                </div>
                <div className="timeline-context-card">
                  <strong>Salto pendiente</strong>
                  <p>
                    {pendingSectionJump
                      ? `${pendingSectionJump.targetSectionName} | ${pendingSectionJump.trigger}`
                      : "Sin salto programado"}
                  </p>
                </div>
                <div className="timeline-context-card">
                  <strong>Seleccion de seccion</strong>
                  <p>
                    {activeSectionDraft
                      ? `${formatClock(activeSectionDraft.startSeconds)} -> ${formatClock(
                          activeSectionDraft.endSeconds,
                        )}`
                      : sectionSelectionMode
                        ? "Arrastra sobre el timeline para marcar un rango."
                        : "Activa el modo seccion para seleccionar un rango."}
                  </p>
                  <div className="timeline-context-actions">
                    <button
                      disabled={!activeSectionDraft || isBusy}
                      type="button"
                      onClick={() => void handleCreateSection()}
                    >
                      Crear Seccion
                    </button>
                    <button
                      disabled={!sectionDraft && !timelineDrag}
                      type="button"
                      onClick={() => {
                        setSectionDraft(null);
                        setTimelineDrag(null);
                      }}
                    >
                      Limpiar
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="timeline-shell">
              <div className="timeline-sidebar">
                <div className="timeline-sidebar-spacer" aria-hidden="true" />
                <div className="timeline-labels">
                  {tracks.map((track) => {
                    const trackClips = clips.filter((clip) => clip.trackId === track.id);
                    const primaryClip = trackClips[0] ?? null;
                    const headerLabel = primaryClip ? clipDisplayName(primaryClip) : track.name;

                    return (
                      <article
                        aria-label={`Cabecera de pista ${headerLabel}`}
                        className={`timeline-track-card${
                          selectedClip?.trackId === track.id ? " is-selected" : ""
                        }`}
                        key={track.id}
                        role="group"
                      >
                        <strong>{headerLabel}</strong>
                        <span>
                          {track.groupName ??
                            `${trackClips.length} clip${trackClips.length === 1 ? "" : "s"}`}
                        </span>
                      </article>
                    );
                  })}
                </div>
              </div>

              <div
                ref={timelineScrollRef}
                className="timeline-scroll"
                onPointerCancel={handleTimelinePointerCancel}
                onPointerDown={handleTimelinePointerDown}
                onPointerMove={handleTimelinePointerMove}
                onPointerUp={handleTimelinePointerUp}
              >
                <div
                  ref={timelineContentRef}
                  className="timeline-content"
                  style={{ width: `${Math.max(zoomLevel * 100, 100)}%` }}
                >
                  <div className="timeline-ruler">
                    <div className="timeline-sections-layer" aria-hidden="true">
                      {sections.map((section) => (
                        <div
                          className={`timeline-section-chip${
                            currentSection?.id === section.id ? " is-current" : ""
                          }`}
                          key={section.id}
                          style={sectionStyle(section, durationSeconds)}
                        >
                          <span>{section.name}</span>
                        </div>
                      ))}
                      {activeSectionDraft && (
                        <div
                          className="timeline-section-chip is-draft"
                          style={sectionStyle(activeSectionDraft, durationSeconds)}
                        >
                          <span>Borrador</span>
                        </div>
                      )}
                    </div>
                    {rulerMarks.map((mark) => (
                      <div className="ruler-mark" key={mark.seconds} style={{ left: `${mark.percent}%` }}>
                        <span>{mark.label}</span>
                      </div>
                    ))}
                  </div>

                  <div className="timeline-body">
                    <div className="timeline-cursor" style={{ left: `${cursorPercent}%` }} />

                    {activeSectionDraft && (
                      <div
                        className="timeline-section-overlay"
                        style={sectionStyle(activeSectionDraft, durationSeconds)}
                      />
                    )}

                    {tracks.map((track) => (
                      <article className="timeline-row" key={track.id}>
                        <div className="timeline-lane" aria-label={`Carril de ${track.name}`}>
                          {clips
                            .filter((clip) => clip.trackId === track.id)
                            .map((clip) => (
                              <button
                                aria-label={`Clip ${clipDisplayName(clip)}`}
                                aria-pressed={selectedClipId === clip.id}
                                className={`clip-block${selectedClipId === clip.id ? " is-selected" : ""}`}
                                key={clip.id}
                                style={clipStyle(clip, durationSeconds)}
                                title={`${clipDisplayName(clip)} | ${formatClock(
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
            Usa <strong>Crear Cancion</strong> para abrir un proyecto vacio, o{" "}
            <strong>Importar WAVs</strong> para seleccionar una o varias pistas y empezar a
            escucharlas con <strong>Play</strong>.
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

function sectionStyle(
  section: Pick<SectionSummary, "startSeconds" | "endSeconds">,
  durationSeconds: number,
) {
  const safeDuration = Math.max(durationSeconds, 0.001);
  const startSeconds = Math.max(0, Math.min(section.startSeconds, safeDuration));
  const endSeconds = Math.max(startSeconds, Math.min(section.endSeconds, safeDuration));
  const left = (startSeconds / safeDuration) * 100;
  const width = Math.max(((endSeconds - startSeconds) / safeDuration) * 100, 0.35);

  return {
    left: `${left}%`,
    width: `${width}%`,
  };
}

function clipDisplayName(clip: ClipSummary) {
  const pathSegments = clip.filePath.split(/[\\/]/);
  const fileName = pathSegments[pathSegments.length - 1] ?? clip.trackName;
  const stem = fileName.replace(/\.[^.]+$/, "");
  return stem || clip.trackName;
}

function normalizeRange(startSeconds: number, endSeconds: number): SectionDraft {
  return {
    startSeconds: Math.min(startSeconds, endSeconds),
    endSeconds: Math.max(startSeconds, endSeconds),
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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
