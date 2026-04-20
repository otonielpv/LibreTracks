import { useEffect, useRef, useState } from "react";
import {
  assignTrackToGroup,
  cancelSectionJump,
  createGroup,
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
  scheduleSectionJump,
  seekTransport,
  setGroupVolume,
  setTrackVolume,
  stopTransport,
  toggleGroupMute,
  toggleTrackMute,
  type ClipSummary,
  type PendingJumpSummary,
  type SectionSummary,
  type SongSummary,
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

type ClipDragState =
  | {
      clipId: string;
      pointerId: number;
      pointerStartSeconds: number;
      originTimelineStartSeconds: number;
      previewTimelineStartSeconds: number;
      hasMoved: boolean;
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
  const [zoomLevel, setZoomLevel] = useState(1.75);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [clipStartDraft, setClipStartDraft] = useState("0.00");
  const [sectionSelectionMode, setSectionSelectionMode] = useState(false);
  const [sectionDraft, setSectionDraft] = useState<SectionDraft | null>(null);
  const [timelineDrag, setTimelineDrag] = useState<TimelineDragState>(null);
  const [clipDrag, setClipDrag] = useState<ClipDragState>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [jumpTargetSectionId, setJumpTargetSectionId] = useState<string | null>(null);
  const [jumpBars, setJumpBars] = useState(4);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineContentRef = useRef<HTMLDivElement | null>(null);
  const clipDragRef = useRef<ClipDragState>(null);

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
  const selectedSection = sections.find((section) => section.id === selectedSectionId) ?? null;
  const currentSection = snapshot?.currentSection ?? null;
  const pendingSectionJump = snapshot?.pendingSectionJump ?? null;
  const activeSectionDraft =
    timelineDrag?.mode === "section"
      ? normalizeRange(timelineDrag.startSeconds, timelineDrag.currentSeconds)
      : sectionDraft;
  const pendingJumpExecuteAt = song
    ? resolvePendingJumpExecuteAt(song, displayedPositionSeconds, currentSection, pendingSectionJump)
    : null;
  const projectLocation = snapshot?.songDir ?? (song ? "Proyecto sin guardar" : "Sesion vacia");
  const clipCount = clips.length;
  const clipsByTrack = tracks.reduce<Record<string, ClipSummary[]>>((collection, track) => {
    collection[track.id] = [];
    return collection;
  }, {});

  for (const clip of clips) {
    if (!clipsByTrack[clip.trackId]) {
      clipsByTrack[clip.trackId] = [];
    }

    clipsByTrack[clip.trackId].push(clip);
  }

  useEffect(() => {
    if (!selectedClipId) {
      return;
    }

    if (!clips.some((clip) => clip.id === selectedClipId)) {
      setSelectedClipId(null);
    }
  }, [clips, selectedClipId]);

  useEffect(() => {
    if (!selectedSectionId) {
      return;
    }

    if (!sections.some((section) => section.id === selectedSectionId)) {
      setSelectedSectionId(null);
    }
  }, [sections, selectedSectionId]);

  useEffect(() => {
    if (!selectedClip) {
      setClipStartDraft("0.00");
      return;
    }

    const previewStart =
      clipDrag?.clipId === selectedClip.id
        ? clipDrag.previewTimelineStartSeconds
        : selectedClip.timelineStartSeconds;

    setClipStartDraft(previewStart.toFixed(2));
  }, [clipDrag, selectedClip]);

  useEffect(() => {
    if (!sections.length) {
      setJumpTargetSectionId(null);
      return;
    }

    if (!jumpTargetSectionId || !sections.some((section) => section.id === jumpTargetSectionId)) {
      const fallbackSectionId = selectedSectionId ?? sections[0]?.id ?? null;
      setJumpTargetSectionId(fallbackSectionId);
    }
  }, [jumpTargetSectionId, sections, selectedSectionId]);

  const resetEditorSelections = () => {
    setSelectedClipId(null);
    setSelectedSectionId(null);
    setSectionDraft(null);
    setTimelineDrag(null);
    setClipDrag(null);
    clipDragRef.current = null;
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
    setStatus("Selecciona los WAVs que quieras importar...");

    await waitForNextPaint();

    try {
      setStatus("Importando WAVs y preparando waveforms...");
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

  const handleSeek = async (nextPositionSeconds: number) => {
    try {
      const nextSnapshot = await seekTransport(nextPositionSeconds);
      setSnapshot(nextSnapshot);
      setStatus(`Cursor movido a ${formatClock(nextPositionSeconds)}.`);
    } catch (error) {
      setStatus(`No se pudo mover el transporte: ${String(error)}`);
    }
  };

  const persistClipMove = async (clip: ClipSummary, nextTimelineStartSeconds: number) => {
    setIsBusy(true);

    try {
      const sanitizedStartSeconds = roundTimelineSeconds(Math.max(0, nextTimelineStartSeconds));
      const nextSnapshot = await moveClip(clip.id, sanitizedStartSeconds);
      setSnapshot(nextSnapshot);
      setSelectedClipId(clip.id);
      setStatus(`${clipDisplayName(clip)} movido a ${formatClock(sanitizedStartSeconds)}.`);
    } catch (error) {
      setStatus(`No se pudo mover el clip: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleMoveSelectedClip = async (nextTimelineStartSeconds: number) => {
    if (!selectedClip) {
      return;
    }

    await persistClipMove(selectedClip, nextTimelineStartSeconds);
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
      const createdSection =
        nextSnapshot.song?.sections.find(
          (section) =>
            nearlyEqual(section.startSeconds, activeSectionDraft.startSeconds) &&
            nearlyEqual(section.endSeconds, activeSectionDraft.endSeconds),
        ) ?? nextSnapshot.song?.sections.at(-1) ?? null;

      setSnapshot(nextSnapshot);
      setSectionDraft(null);
      setSectionSelectionMode(false);
      setSelectedSectionId(createdSection?.id ?? null);
      setJumpTargetSectionId(createdSection?.id ?? null);
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

  const handleCreateGroup = async () => {
    if (!groupNameDraft.trim()) {
      setStatus("El nombre del grupo no puede estar vacio.");
      return;
    }

    setIsBusy(true);

    try {
      const trimmedGroupName = groupNameDraft.trim();
      const nextSnapshot = await createGroup(trimmedGroupName);
      setSnapshot(nextSnapshot);
      setGroupNameDraft("");
      setStatus(`Grupo creado: ${trimmedGroupName}.`);
    } catch (error) {
      setStatus(`No se pudo crear el grupo: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleTrackVolumeChange = async (trackId: string, value: number) => {
    try {
      const nextSnapshot = await setTrackVolume(trackId, value / 100);
      setSnapshot(nextSnapshot);
    } catch (error) {
      setStatus(`No se pudo cambiar el volumen de pista: ${String(error)}`);
    }
  };

  const handleTrackMuteToggle = async (trackId: string) => {
    try {
      const nextSnapshot = await toggleTrackMute(trackId);
      setSnapshot(nextSnapshot);
    } catch (error) {
      setStatus(`No se pudo cambiar el mute de pista: ${String(error)}`);
    }
  };

  const handleGroupVolumeChange = async (groupId: string, value: number) => {
    try {
      const nextSnapshot = await setGroupVolume(groupId, value / 100);
      setSnapshot(nextSnapshot);
    } catch (error) {
      setStatus(`No se pudo cambiar el volumen de grupo: ${String(error)}`);
    }
  };

  const handleGroupMuteToggle = async (groupId: string) => {
    try {
      const nextSnapshot = await toggleGroupMute(groupId);
      setSnapshot(nextSnapshot);
    } catch (error) {
      setStatus(`No se pudo cambiar el mute de grupo: ${String(error)}`);
    }
  };

  const handleTrackGroupChange = async (trackId: string, nextGroupId: string) => {
    try {
      const nextSnapshot = await assignTrackToGroup(trackId, nextGroupId || null);
      setSnapshot(nextSnapshot);
    } catch (error) {
      setStatus(`No se pudo asignar la pista al grupo: ${String(error)}`);
    }
  };

  const handleScheduleJump = async (trigger: "immediate" | "section_end" | "after_bars") => {
    if (!jumpTargetSectionId) {
      setStatus("Selecciona primero una seccion del timeline.");
      return;
    }

    try {
      const nextSnapshot = await scheduleSectionJump({
        targetSectionId: jumpTargetSectionId,
        trigger,
        bars: trigger === "after_bars" ? jumpBars : undefined,
      });
      setSnapshot(nextSnapshot);
      setStatus("Salto de seccion programado.");
    } catch (error) {
      setStatus(`No se pudo programar el salto: ${String(error)}`);
    }
  };

  const handleCancelJump = async () => {
    try {
      const nextSnapshot = await cancelSectionJump();
      setSnapshot(nextSnapshot);
      setStatus("Salto pendiente cancelado.");
    } catch (error) {
      setStatus(`No se pudo cancelar el salto: ${String(error)}`);
    }
  };

  const resolveTimelineSeconds = (clientX: number) => {
    const scrollElement = timelineScrollRef.current;
    const contentElement = timelineContentRef.current;
    if (!scrollElement || !contentElement || durationSeconds <= 0) {
      return 0;
    }

    const scrollRect = scrollElement.getBoundingClientRect();
    const contentRect = contentElement.getBoundingClientRect();
    const contentWidth = contentRect.width || contentElement.scrollWidth || scrollRect.width || 1;
    const relativeX = clientX - scrollRect.left + scrollElement.scrollLeft;
    const ratio = clamp(relativeX / contentWidth, 0, 1);
    return ratio * durationSeconds;
  };

  const handleTimelinePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!song || durationSeconds <= 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest(".clip-block") || target.closest(".timeline-section-chip")) {
      return;
    }

    const nextSeconds = resolveTimelineSeconds(event.clientX);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelectedClipId(null);
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

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setTimelineDrag(null);

    if (currentDrag.mode === "seek") {
      void handleSeek(currentDrag.currentSeconds);
      return;
    }

    const nextDraft = normalizeRange(currentDrag.startSeconds, currentDrag.currentSeconds);
    setSectionDraft(nextDraft);
    setSelectedSectionId(null);
  };

  const handleTimelinePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!timelineDrag || timelineDrag.pointerId !== event.pointerId) {
      return;
    }

    setTimelineDrag(null);
  };

  const handleClipPointerDown = (clip: ClipSummary, event: React.PointerEvent<HTMLButtonElement>) => {
    if (!song || durationSeconds <= 0) {
      return;
    }

    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pointerStartSeconds = resolveTimelineSeconds(event.clientX);

    setSelectedClipId(clip.id);
    const nextClipDrag: ClipDragState = {
      clipId: clip.id,
      pointerId: event.pointerId,
      pointerStartSeconds,
      originTimelineStartSeconds: clip.timelineStartSeconds,
      previewTimelineStartSeconds: clip.timelineStartSeconds,
      hasMoved: false,
    };

    clipDragRef.current = nextClipDrag;
    setClipDrag(nextClipDrag);
  };

  const handleClipPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    const currentDrag = clipDragRef.current;
    if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
      return;
    }

    const deltaSeconds = resolveTimelineSeconds(event.clientX) - currentDrag.pointerStartSeconds;
    const nextTimelineStartSeconds = Math.max(0, currentDrag.originTimelineStartSeconds + deltaSeconds);
    const nextClipDrag: ClipDragState = {
      ...currentDrag,
      previewTimelineStartSeconds: roundTimelineSeconds(nextTimelineStartSeconds),
      hasMoved: currentDrag.hasMoved || Math.abs(deltaSeconds) >= 0.2,
    };

    clipDragRef.current = nextClipDrag;
    setClipDrag(nextClipDrag);
  };

  const handleClipPointerUp = (clip: ClipSummary, event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    const currentDrag = clipDragRef.current;
    if (!currentDrag || currentDrag.pointerId !== event.pointerId || currentDrag.clipId !== clip.id) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const releaseDeltaSeconds = resolveTimelineSeconds(event.clientX) - currentDrag.pointerStartSeconds;
    const releaseHasMoved = currentDrag.hasMoved || Math.abs(releaseDeltaSeconds) >= 0.2;
    const releaseTimelineStartSeconds = roundTimelineSeconds(
      Math.max(0, currentDrag.originTimelineStartSeconds + releaseDeltaSeconds),
    );
    clipDragRef.current = null;
    setClipDrag(null);

    if (!releaseHasMoved) {
      setSelectedClipId(clip.id);
      setStatus(`Clip seleccionado: ${clipDisplayName(clip)}.`);
      return;
    }

    void persistClipMove(clip, releaseTimelineStartSeconds);
  };

  const handleClipPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!clipDragRef.current || clipDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    clipDragRef.current = null;
    setClipDrag(null);
  };

  const transportStateLabel = snapshot?.playbackState ?? "empty";

  return (
    <section className="daw-shell">
      {isBusy && (
        <div className="busy-overlay" role="status" aria-live="polite">
          <div className="busy-overlay-card">
            <strong>LibreTracks trabajando</strong>
            <p>{status}</p>
          </div>
        </div>
      )}

      <header className="daw-topbar">
        <div className="brand-cluster">
          <p className="brand-kicker">LibreTracks</p>
          <h1>LibreTracks Timeline DAW</h1>
          <p className="brand-subtitle">
            Timeline primero, mezcla integrada y edicion directa sobre clips y secciones.
          </p>
        </div>

        <div className="transport-cluster" aria-label="Controles de transporte">
          <div className="transport-buttons">
            <button disabled={!song || isBusy} type="button" onClick={() => void handlePlay()}>
              Play
            </button>
            <button disabled={!song || isBusy} type="button" onClick={() => void handlePause()}>
              Pause
            </button>
            <button disabled={!song || isBusy} type="button" onClick={() => void handleStop()}>
              Stop
            </button>
          </div>

          <div className="transport-readout">
            <strong>{formatClock(displayedPositionSeconds)}</strong>
            <span className={`transport-pill is-${transportStateLabel}`}>{transportStateLabel}</span>
            {song && (
              <span className="transport-meta">
                {song.bpm} BPM | {song.timeSignature} | {tracks.length} pistas
              </span>
            )}
          </div>
        </div>

        <div className="session-actions">
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
      </header>

      <div className="status-ribbon" role="status">
        <div>
          <strong>{song?.title ?? "Todavia no hay cancion cargada"}</strong>
          <p>{status}</p>
        </div>
        <div className="status-ribbon-meta">
          <span>{song ? `${clipCount} clips | ${sections.length} secciones` : "Sin proyecto"}</span>
          <span>{projectLocation}</span>
        </div>
      </div>

      {song ? (
        <>
          <section className="overview-strip" aria-label="Resumen de la sesion">
            <article className="overview-card">
              <span className="overview-label">Proyecto</span>
              <strong>{song.title}</strong>
              <p>
                {song.artist || "Sin artista"} | {formatClock(positionSeconds)} /{" "}
                {formatClock(durationSeconds)}
              </p>
            </article>

            <article className="overview-card">
              <span className="overview-label">Timeline</span>
              <strong>{tracks.length} pistas activas</strong>
              <p>{clipCount} clips, zoom {zoomLevel.toFixed(1)}x y cursor editable desde la regla.</p>
            </article>

            <article className="overview-card">
              <span className="overview-label">Secciones</span>
              <strong>{currentSection ? currentSection.name : "Sin seccion activa"}</strong>
              <p>
                {pendingSectionJump
                  ? `Salto armado hacia ${pendingSectionJump.targetSectionName}.`
                  : "Sin salto musical pendiente."}
              </p>
            </article>
          </section>

          <section className="submix-panel">
            <div className="submix-header">
              <div>
                <h2>Submezclas</h2>
                <p>Los grupos viven arriba del timeline y las pistas se asignan desde su cabecera.</p>
              </div>

              <div className="group-create-row">
                <label className="compact-field">
                  <span>Nuevo grupo</span>
                  <input
                    aria-label="Nombre del nuevo grupo"
                    disabled={isBusy}
                    type="text"
                    value={groupNameDraft}
                    onChange={(event) => {
                      setGroupNameDraft(event.target.value);
                    }}
                  />
                </label>
                <button disabled={isBusy} type="button" onClick={() => void handleCreateGroup()}>
                  Crear Grupo
                </button>
              </div>
            </div>

            <div className="submix-strip">
              {groups.map((group) => (
                <article className="submix-card" key={group.id}>
                  <div className="submix-card-top">
                    <div>
                      <strong>{group.name}</strong>
                      <p>Vol {Math.round(group.volume * 100)}%</p>
                    </div>
                    <button type="button" onClick={() => void handleGroupMuteToggle(group.id)}>
                      {group.muted ? "Unmute" : "Mute"}
                    </button>
                  </div>

                  <label className="compact-slider">
                    <span>Volumen de grupo</span>
                    <input
                      aria-label={`Volumen de grupo ${group.name}`}
                      max="100"
                      min="0"
                      type="range"
                      value={Math.round(group.volume * 100)}
                      onChange={(event) => {
                        void handleGroupVolumeChange(group.id, Number(event.target.value));
                      }}
                    />
                  </label>
                </article>
              ))}
            </div>
          </section>

          <section className="timeline-stage">
            <div className="timeline-stage-header">
              <div>
                <h2>Timeline principal</h2>
                <p>
                  Arrastra clips horizontalmente, crea regiones por rango y arma saltos sin salir
                  de la linea de tiempo.
                </p>
              </div>

              <div className="timeline-tools">
                <label className="zoom-field">
                  <span>Zoom</span>
                  <input
                    aria-label="Zoom horizontal del timeline"
                    max="4"
                    min="1"
                    step="0.25"
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
                  {sectionSelectionMode ? "Modo region activo" : "Modo region"}
                </button>

                <strong className="timeline-meta">
                  {tracks.length} pistas | {clipCount} clips | {sections.length} secciones
                </strong>
              </div>
            </div>

            <div className="timeline-shell">
              <aside className="timeline-headers" aria-label="Cabeceras de pista">
                <div className="timeline-headers-spacer" aria-hidden="true" />

                {tracks.map((track) => {
                  const trackClips = clipsByTrack[track.id] ?? [];
                  const isTrackSelected = selectedClip?.trackId === track.id;
                  const selectedTrackGroupId =
                    groups.find((group) => group.name === track.groupName)?.id ?? "";

                  return (
                    <article
                      aria-label={`Cabecera de pista ${track.name}`}
                      className={`track-header-card${isTrackSelected ? " is-selected" : ""}`}
                      key={track.id}
                    >
                      <div className="track-header-top">
                        <div>
                          <strong>{track.name}</strong>
                          <p>{track.groupName ?? "Sin grupo"} | {trackClips.length} clips</p>
                        </div>
                        <button type="button" onClick={() => void handleTrackMuteToggle(track.id)}>
                          {track.muted ? "Unmute" : "Mute"}
                        </button>
                      </div>

                      <label className="compact-slider">
                        <span>Vol {Math.round(track.volume * 100)}%</span>
                        <input
                          aria-label={`Volumen de pista ${track.name}`}
                          max="100"
                          min="0"
                          type="range"
                          value={Math.round(track.volume * 100)}
                          onChange={(event) => {
                            void handleTrackVolumeChange(track.id, Number(event.target.value));
                          }}
                        />
                      </label>

                      <label className="compact-field">
                        <span>Grupo</span>
                        <select
                          aria-label={`Grupo de pista ${track.name}`}
                          value={selectedTrackGroupId}
                          onChange={(event) => {
                            void handleTrackGroupChange(track.id, event.target.value);
                          }}
                        >
                          <option value="">Sin grupo</option>
                          {groups.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </article>
                  );
                })}
              </aside>

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
                        <button
                          aria-pressed={selectedSectionId === section.id}
                          className={`timeline-section-chip${
                            currentSection?.id === section.id ? " is-current" : ""
                          }${jumpTargetSectionId === section.id ? " is-target" : ""}${
                            selectedSectionId === section.id ? " is-selected" : ""
                          }`}
                          key={section.id}
                          style={sectionStyle(section, durationSeconds)}
                          type="button"
                          onClick={() => {
                            setSelectedSectionId(section.id);
                            setJumpTargetSectionId(section.id);
                            setSectionDraft(null);
                          }}
                        >
                          <span>{section.name}</span>
                        </button>
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

                    {pendingJumpExecuteAt !== null && (
                      <div
                        className="timeline-jump-marker"
                        style={{ left: `${(pendingJumpExecuteAt / Math.max(durationSeconds, 0.001)) * 100}%` }}
                      >
                        <span>{formatTimelineMark(pendingJumpExecuteAt)}</span>
                      </div>
                    )}

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

                    {pendingJumpExecuteAt !== null && (
                      <div
                        className="timeline-jump-guide"
                        style={{ left: `${(pendingJumpExecuteAt / Math.max(durationSeconds, 0.001)) * 100}%` }}
                      />
                    )}

                    {tracks.map((track) => (
                      <article className="timeline-row" key={track.id}>
                        <div className="timeline-lane" aria-label={`Carril de ${track.name}`}>
                          {(clipsByTrack[track.id] ?? []).map((clip) => {
                            const isDraggedClip = clipDrag?.clipId === clip.id;
                            const previewStartSeconds = isDraggedClip
                              ? clipDrag.previewTimelineStartSeconds
                              : clip.timelineStartSeconds;

                            return (
                              <div className="clip-shell" key={clip.id}>
                                {isDraggedClip && (
                                  <div
                                    aria-hidden="true"
                                    className="clip-block is-preview"
                                    style={clipStyle(clip, durationSeconds, previewStartSeconds)}
                                  >
                                    <ClipFace clip={clip} />
                                  </div>
                                )}

                                <button
                                  aria-label={`Clip ${clipDisplayName(clip)}`}
                                  aria-pressed={selectedClipId === clip.id}
                                  className={`clip-block${selectedClipId === clip.id ? " is-selected" : ""}${
                                    isDraggedClip ? " is-drag-source" : ""
                                  }`}
                                  style={clipStyle(clip, durationSeconds)}
                                  title={`${clipDisplayName(clip)} | ${formatClock(
                                    previewStartSeconds,
                                  )} / ${formatClock(clip.durationSeconds)}`}
                                  type="button"
                                  onPointerCancel={handleClipPointerCancel}
                                  onPointerDown={(event) => {
                                    handleClipPointerDown(clip, event);
                                  }}
                                  onPointerMove={handleClipPointerMove}
                                  onPointerUp={(event) => {
                                    handleClipPointerUp(clip, event);
                                  }}
                                >
                                  <ClipFace clip={clip} />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="context-dock" aria-label="Barra contextual inferior">
            <article className="context-card">
              <span className="context-label">Clip</span>
              {selectedClip ? (
                <>
                  <strong>{clipDisplayName(selectedClip)}</strong>
                  <p>
                    Inicio {formatClock(clipDrag?.clipId === selectedClip.id ? clipDrag.previewTimelineStartSeconds : selectedClip.timelineStartSeconds)}
                    {" | "}Duracion {formatClock(selectedClip.durationSeconds)} | Gain{" "}
                    {Math.round(selectedClip.gain * 100)}%
                  </p>
                  <div className="context-actions">
                    <label className="compact-field">
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
                </>
              ) : (
                <>
                  <strong>Sin clip seleccionado</strong>
                  <p>Haz click o arrastra un clip del timeline para editarlo directamente.</p>
                </>
              )}
            </article>

            <article className="context-card">
              <span className="context-label">Seccion</span>
              {selectedSection ? (
                <>
                  <strong>{selectedSection.name}</strong>
                  <p>
                    {formatClock(selectedSection.startSeconds)} {"->"}{" "}
                    {formatClock(selectedSection.endSeconds)}
                  </p>
                </>
              ) : activeSectionDraft ? (
                <>
                  <strong>Rango en borrador</strong>
                  <p>
                    {formatClock(activeSectionDraft.startSeconds)} {"->"}{" "}
                    {formatClock(activeSectionDraft.endSeconds)}
                  </p>
                </>
              ) : (
                <>
                  <strong>Sin seccion seleccionada</strong>
                  <p>Activa el modo region y arrastra sobre la regla para crear una nueva.</p>
                </>
              )}

              <div className="context-actions">
                <button
                  disabled={!activeSectionDraft || isBusy}
                  type="button"
                  onClick={() => void handleCreateSection()}
                >
                  Crear Seccion
                </button>
                <button
                  disabled={!sectionDraft && !timelineDrag && !selectedSection}
                  type="button"
                  onClick={() => {
                    setSectionDraft(null);
                    setTimelineDrag(null);
                    setSelectedSectionId(null);
                  }}
                >
                  Limpiar
                </button>
              </div>
            </article>

            <article className="context-card">
              <span className="context-label">Salto musical</span>
              <strong>{pendingSectionJump ? pendingSectionJump.targetSectionName : "Sin salto programado"}</strong>
              <p>
                {selectedSection
                  ? `Destino seleccionado: ${selectedSection.name}.`
                  : jumpTargetSectionId
                    ? "La region armada se usa como destino del salto."
                    : "Selecciona una region del timeline para armar el salto."}
              </p>
              <div className="context-actions">
                <button
                  disabled={!jumpTargetSectionId || isBusy}
                  type="button"
                  onClick={() => void handleScheduleJump("immediate")}
                >
                  Ir ahora
                </button>
                <button
                  disabled={!jumpTargetSectionId || isBusy}
                  type="button"
                  onClick={() => void handleScheduleJump("section_end")}
                >
                  Al final
                </button>
                <button
                  disabled={!jumpTargetSectionId || isBusy}
                  type="button"
                  onClick={() => void handleScheduleJump("after_bars")}
                >
                  En compases
                </button>
                <label className="compact-field compact-field-small">
                  <span>Compases</span>
                  <input
                    aria-label="Compases del salto"
                    disabled={isBusy}
                    max="16"
                    min="1"
                    type="number"
                    value={jumpBars}
                    onChange={(event) => {
                      setJumpBars(Math.max(1, Number(event.target.value) || 1));
                    }}
                  />
                </label>
                <button
                  disabled={!pendingSectionJump || isBusy}
                  type="button"
                  onClick={() => void handleCancelJump()}
                >
                  Cancelar salto
                </button>
              </div>
              {pendingJumpExecuteAt !== null && (
                <p className="jump-timing">
                  Ejecucion estimada en {formatClock(pendingJumpExecuteAt)}.
                </p>
              )}
            </article>
          </section>
        </>
      ) : (
        <div className="empty-state">
          <strong>Prepara una sesion para empezar</strong>
          <p>
            Usa <strong>Crear Cancion</strong> para abrir un proyecto vacio, o{" "}
            <strong>Importar WAVs</strong> para traer pistas y trabajar directamente desde el
            timeline.
          </p>
        </div>
      )}
    </section>
  );
}

function ClipFace({ clip }: { clip: ClipSummary }) {
  return (
    <>
      <div className="clip-info">
        <span className="clip-name">{clipDisplayName(clip)}</span>
        <span className="clip-time">{formatTimelineMark(clip.timelineStartSeconds)}</span>
      </div>
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
    </>
  );
}

function clipStyle(
  clip: ClipSummary,
  durationSeconds: number,
  overrideTimelineStartSeconds?: number,
) {
  const safeDuration = Math.max(durationSeconds, 0.001);
  const startSeconds = overrideTimelineStartSeconds ?? clip.timelineStartSeconds;
  const left = (startSeconds / safeDuration) * 100;
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
  const markCount = Math.max(8, Math.round(10 * zoomLevel));

  return Array.from({ length: markCount + 1 }, (_, index) => {
    const seconds = (safeDuration / markCount) * index;

    return {
      seconds,
      percent: (seconds / safeDuration) * 100,
      label: formatTimelineMark(seconds),
    };
  });
}

function resolvePendingJumpExecuteAt(
  song: SongSummary,
  currentPositionSeconds: number,
  currentSection: SectionSummary | null,
  pendingSectionJump: PendingJumpSummary | null,
) {
  if (!pendingSectionJump) {
    return null;
  }

  if (pendingSectionJump.trigger === "immediate") {
    return currentPositionSeconds;
  }

  if (pendingSectionJump.trigger === "section_end") {
    return currentSection?.endSeconds ?? null;
  }

  const bars = extractBarsFromTrigger(pendingSectionJump.trigger);
  if (!bars) {
    return null;
  }

  const beatsPerBar = parseBeatsPerBar(song.timeSignature);
  const secondsPerBeat = 60 / Math.max(song.bpm, 1);
  const secondsPerBar = beatsPerBar * secondsPerBeat;
  const quantizedBars = Math.max(1, bars);
  const barIndex = Math.ceil(currentPositionSeconds / secondsPerBar / quantizedBars) * quantizedBars;
  return Number((barIndex * secondsPerBar).toFixed(3));
}

function extractBarsFromTrigger(trigger: PendingJumpSummary["trigger"]) {
  if (!trigger.startsWith("after_bars:")) {
    return null;
  }

  const rawBars = Number(trigger.split(":")[1]);
  return Number.isFinite(rawBars) && rawBars > 0 ? rawBars : null;
}

function parseBeatsPerBar(timeSignature: string) {
  const beats = Number(timeSignature.split("/")[0]);
  return Number.isFinite(beats) && beats > 0 ? beats : 4;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundTimelineSeconds(totalSeconds: number) {
  return Number(totalSeconds.toFixed(2));
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 0.0001;
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

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), 0);
  });
}
