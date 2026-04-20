import { useEffect, useRef, useState } from "react";
import {
  assignTrackToGroup,
  cancelSectionJump,
  createGroup,
  createSection,
  createSong,
  deleteClip,
  deleteSection,
  duplicateClip,
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
  updateClipWindow,
  updateSection,
  type ClipSummary,
  type PendingJumpSummary,
  type SectionSummary,
  type SongSummary,
  type TransportSnapshot,
} from "./desktopApi";

const TIMELINE_ZOOM_MIN = 1;
const TIMELINE_ZOOM_MAX = 4;
const TIMELINE_ZOOM_STEP = 0.25;

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

type ClipTrimDragState =
  | {
      clipId: string;
      edge: "start" | "end";
      pointerId: number;
      previewTimelineStartSeconds: number;
      previewSourceStartSeconds: number;
      previewDurationSeconds: number;
    }
  | null;

type SectionDraft = {
  startSeconds: number;
  endSeconds: number;
};

type SectionResizeDragState =
  | {
      sectionId: string;
      edge: "start" | "end";
      pointerId: number;
      previewStartSeconds: number;
      previewEndSeconds: number;
    }
  | null;

export function TransportPanel() {
  const [snapshot, setSnapshot] = useState<TransportSnapshot | null>(null);
  const [status, setStatus] = useState("Cargando estado de la sesion...");
  const [isBusy, setIsBusy] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1.75);
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [clipStartDraft, setClipStartDraft] = useState("0.00");
  const [clipSourceStartDraft, setClipSourceStartDraft] = useState("0.00");
  const [clipDurationDraft, setClipDurationDraft] = useState("0.00");
  const [sectionNameDraft, setSectionNameDraft] = useState("");
  const [sectionStartDraft, setSectionStartDraft] = useState("0.00");
  const [sectionEndDraft, setSectionEndDraft] = useState("0.00");
  const [sectionSelectionMode, setSectionSelectionMode] = useState(false);
  const [sectionDraft, setSectionDraft] = useState<SectionDraft | null>(null);
  const [sectionResizeDrag, setSectionResizeDrag] = useState<SectionResizeDragState>(null);
  const [timelineDrag, setTimelineDrag] = useState<TimelineDragState>(null);
  const [clipDrag, setClipDrag] = useState<ClipDragState>(null);
  const [clipTrimDrag, setClipTrimDrag] = useState<ClipTrimDragState>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [jumpTargetSectionId, setJumpTargetSectionId] = useState<string | null>(null);
  const [jumpBars, setJumpBars] = useState(4);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineContentRef = useRef<HTMLDivElement | null>(null);
  const clipDragRef = useRef<ClipDragState>(null);
  const clipTrimDragRef = useRef<ClipTrimDragState>(null);
  const sectionResizeDragRef = useRef<SectionResizeDragState>(null);

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
  const activeClipTrimPreview =
    clipTrimDrag === null
      ? null
      : {
          timelineStartSeconds: clipTrimDrag.previewTimelineStartSeconds,
          sourceStartSeconds: clipTrimDrag.previewSourceStartSeconds,
          durationSeconds: clipTrimDrag.previewDurationSeconds,
        };
  const activeSectionDraft =
    timelineDrag?.mode === "section"
      ? normalizeRange(timelineDrag.startSeconds, timelineDrag.currentSeconds)
      : sectionDraft;
  const activeSectionResizePreview =
    sectionResizeDrag === null
      ? null
      : {
          startSeconds: sectionResizeDrag.previewStartSeconds,
          endSeconds: sectionResizeDrag.previewEndSeconds,
        };
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

  const updateSectionResizeDragState = (
    nextValue:
      | SectionResizeDragState
      | ((currentDrag: SectionResizeDragState) => SectionResizeDragState),
  ) => {
    const resolvedValue =
      typeof nextValue === "function"
        ? nextValue(sectionResizeDragRef.current)
        : nextValue;

    sectionResizeDragRef.current = resolvedValue;
    setSectionResizeDrag(resolvedValue);
  };

  const updateClipTrimDragState = (
    nextValue: ClipTrimDragState | ((currentDrag: ClipTrimDragState) => ClipTrimDragState),
  ) => {
    const resolvedValue =
      typeof nextValue === "function" ? nextValue(clipTrimDragRef.current) : nextValue;

    clipTrimDragRef.current = resolvedValue;
    setClipTrimDrag(resolvedValue);
  };

  useEffect(() => {
    if (!selectedClip) {
      setClipStartDraft("0.00");
      setClipSourceStartDraft("0.00");
      setClipDurationDraft("0.00");
      return;
    }

    const previewClipWindow =
      clipTrimDrag?.clipId === selectedClip.id
        ? clipTrimDrag
        : clipDrag?.clipId === selectedClip.id
          ? {
              previewTimelineStartSeconds: clipDrag.previewTimelineStartSeconds,
              previewSourceStartSeconds: selectedClip.sourceStartSeconds,
              previewDurationSeconds: selectedClip.durationSeconds,
            }
          : null;

    setClipStartDraft(
      (previewClipWindow?.previewTimelineStartSeconds ?? selectedClip.timelineStartSeconds).toFixed(2),
    );
    setClipSourceStartDraft(
      (previewClipWindow?.previewSourceStartSeconds ?? selectedClip.sourceStartSeconds).toFixed(2),
    );
    setClipDurationDraft(
      (previewClipWindow?.previewDurationSeconds ?? selectedClip.durationSeconds).toFixed(2),
    );
  }, [clipDrag, clipTrimDrag, selectedClip]);

  useEffect(() => {
    if (!selectedSection) {
      setSectionNameDraft("");
      setSectionStartDraft("0.00");
      setSectionEndDraft("0.00");
      return;
    }

    setSectionNameDraft(selectedSection.name);
    setSectionStartDraft(selectedSection.startSeconds.toFixed(2));
    setSectionEndDraft(selectedSection.endSeconds.toFixed(2));
  }, [selectedSection]);

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

  const updateTimelineZoom = (nextZoomLevel: number, anchorClientX?: number) => {
    const clampedZoomLevel = clampZoomLevel(nextZoomLevel);
    const scrollElement = timelineScrollRef.current;
    const contentElement = timelineContentRef.current;

    if (!scrollElement || !contentElement) {
      setZoomLevel(clampedZoomLevel);
      return;
    }

    const scrollRect = scrollElement.getBoundingClientRect();
    const contentWidth =
      contentElement.getBoundingClientRect().width ||
      contentElement.scrollWidth ||
      scrollElement.clientWidth ||
      1;
    const anchorViewportOffset =
      anchorClientX === undefined
        ? scrollElement.clientWidth / 2
        : clamp(anchorClientX - scrollRect.left, 0, scrollElement.clientWidth);
    const anchorRatio = clamp(
      (scrollElement.scrollLeft + anchorViewportOffset) / Math.max(contentWidth, 1),
      0,
      1,
    );

    setZoomLevel(clampedZoomLevel);

    window.requestAnimationFrame(() => {
      const nextScrollElement = timelineScrollRef.current;
      const nextContentElement = timelineContentRef.current;
      if (!nextScrollElement || !nextContentElement) {
        return;
      }

      const nextContentWidth =
        nextContentElement.getBoundingClientRect().width ||
        nextContentElement.scrollWidth ||
        nextScrollElement.clientWidth ||
        1;
      const nextScrollLeft = anchorRatio * nextContentWidth - anchorViewportOffset;
      nextScrollElement.scrollLeft = Math.max(0, nextScrollLeft);
    });
  };

  const clearTimelineSelections = () => {
    setSelectedClipId(null);
    setSelectedSectionId(null);
    setSectionDraft(null);
    updateSectionResizeDragState(null);
    setTimelineDrag(null);
    setClipDrag(null);
    clipDragRef.current = null;
    updateClipTrimDragState(null);
  };

  const resetEditorSelections = () => {
    clearTimelineSelections();
  };

  const snapTimelineSeconds = (totalSeconds: number) =>
    maybeSnapSeconds(totalSeconds, song, snapEnabled);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isEditableTarget(event.target)) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        if (!song || isBusy) {
          return;
        }

        if (snapshot?.playbackState === "playing") {
          void handlePause();
          return;
        }

        void handlePlay();
        return;
      }

      if (event.key === "Escape") {
        const hasTransientSelection =
          selectedClipId !== null ||
          selectedSectionId !== null ||
          sectionDraft !== null ||
          timelineDrag !== null ||
          clipDragRef.current !== null ||
          clipTrimDragRef.current !== null;

        if (!hasTransientSelection) {
          return;
        }

        event.preventDefault();
        clearTimelineSelections();
        setStatus("Seleccion del timeline cancelada.");
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedClipId !== null) {
        event.preventDefault();
        if (isBusy) {
          return;
        }

        void handleDeleteSelectedClip();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d" && selectedClipId !== null) {
        event.preventDefault();
        if (isBusy) {
          return;
        }

        void handleDuplicateSelectedClip();
        return;
      }

      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && selectedClip) {
        event.preventDefault();
        if (isBusy) {
          return;
        }

        const nudgeStep = event.shiftKey ? 0.1 : 1;
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        void handleMoveSelectedClip(selectedClip.timelineStartSeconds + direction * nudgeStep);
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [isBusy, sectionDraft, selectedClip, selectedClipId, selectedSectionId, snapshot?.playbackState, song, timelineDrag]);

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
      const sanitizedStartSeconds = roundTimelineSeconds(
        snapTimelineSeconds(Math.max(0, nextTimelineStartSeconds)),
      );
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

  const handleDeleteSelectedClip = async () => {
    if (!selectedClip) {
      return;
    }

    setIsBusy(true);

    try {
      const deletedClipName = clipDisplayName(selectedClip);
      const nextSnapshot = await deleteClip(selectedClip.id);
      setSnapshot(nextSnapshot);
      setSelectedClipId(null);
      setStatus(`Clip eliminado: ${deletedClipName}.`);
    } catch (error) {
      setStatus(`No se pudo borrar el clip: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleApplyClipWindow = async () => {
    if (!selectedClip) {
      return;
    }

    const parsedTimelineStart = Number(clipStartDraft);
    const parsedSourceStart = Number(clipSourceStartDraft);
    const parsedDuration = Number(clipDurationDraft);
    if (
      Number.isNaN(parsedTimelineStart) ||
      Number.isNaN(parsedSourceStart) ||
      Number.isNaN(parsedDuration)
    ) {
      setStatus("La ventana del clip no es valida.");
      return;
    }

    setIsBusy(true);

    try {
      const nextSnapshot = await updateClipWindow({
        clipId: selectedClip.id,
        timelineStartSeconds: roundTimelineSeconds(snapTimelineSeconds(parsedTimelineStart)),
        sourceStartSeconds: roundTimelineSeconds(Math.max(0, parsedSourceStart)),
        durationSeconds: roundTimelineSeconds(parsedDuration),
      });
      const updatedClip =
        nextSnapshot.song?.clips.find((clip) => clip.id === selectedClip.id) ?? null;

      setSnapshot(nextSnapshot);
      setSelectedClipId(selectedClip.id);
      setStatus(`Clip actualizado: ${clipDisplayName(updatedClip ?? selectedClip)}.`);
    } catch (error) {
      setStatus(`No se pudo recortar el clip: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDuplicateSelectedClip = async () => {
    if (!selectedClip) {
      return;
    }

    setIsBusy(true);

    try {
      const duplicatedStart = roundTimelineSeconds(
        snapTimelineSeconds(selectedClip.timelineStartSeconds + selectedClip.durationSeconds),
      );
      const nextSnapshot = await duplicateClip({
        clipId: selectedClip.id,
        timelineStartSeconds: duplicatedStart,
      });
      const duplicatedClip =
        nextSnapshot.song?.clips.find(
          (clip) =>
            clip.id !== selectedClip.id &&
            nearlyEqual(clip.timelineStartSeconds, duplicatedStart) &&
            clip.trackId === selectedClip.trackId,
        ) ?? nextSnapshot.song?.clips.at(-1) ?? null;

      setSnapshot(nextSnapshot);
      setSelectedClipId(duplicatedClip?.id ?? null);
      setStatus(
        `${clipDisplayName(selectedClip)} duplicado en ${formatClock(duplicatedStart)}.`,
      );
    } catch (error) {
      setStatus(`No se pudo duplicar el clip: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
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

  const handleSectionResizePointerDown = (
    section: SectionSummary,
    edge: "start" | "end",
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelectedClipId(null);
    setSelectedSectionId(section.id);
    setJumpTargetSectionId(section.id);
    setSectionDraft(null);
    updateSectionResizeDragState({
      sectionId: section.id,
      edge,
      pointerId: event.pointerId,
      previewStartSeconds: section.startSeconds,
      previewEndSeconds: section.endSeconds,
    });
  };

  const handleSectionResizePointerMove = (
    section: SectionSummary,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    autoScrollTimeline(event.clientX);
    updateSectionResizeDragState((currentDrag) => {
      if (
        currentDrag === null ||
        currentDrag.pointerId !== event.pointerId ||
        currentDrag.sectionId !== section.id
      ) {
        return currentDrag;
      }

      const pointerSeconds = roundTimelineSeconds(resolveTimelineSeconds(event.clientX));
      if (!Number.isFinite(pointerSeconds)) {
        return currentDrag;
      }

      if (currentDrag.edge === "start") {
        return {
          ...currentDrag,
          previewStartSeconds: clamp(pointerSeconds, 0, currentDrag.previewEndSeconds - 0.05),
        };
      }

      return {
        ...currentDrag,
        previewEndSeconds: clamp(pointerSeconds, currentDrag.previewStartSeconds + 0.05, durationSeconds),
      };
    });
  };

  const handleSectionResizePointerUp = async (
    section: SectionSummary,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();

    const currentDrag = sectionResizeDragRef.current;
    if (
      currentDrag === null ||
      currentDrag.pointerId !== event.pointerId ||
      currentDrag.sectionId !== section.id
    ) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    updateSectionResizeDragState(null);
    setIsBusy(true);

    try {
      const nextSnapshot = await updateSection({
        sectionId: section.id,
        name: section.name,
        startSeconds: roundTimelineSeconds(currentDrag.previewStartSeconds),
        endSeconds: roundTimelineSeconds(currentDrag.previewEndSeconds),
      });
      setSnapshot(nextSnapshot);
      setSelectedSectionId(section.id);
      setJumpTargetSectionId(section.id);
      setStatus(`Seccion ajustada: ${section.name}.`);
    } catch (error) {
      setStatus(`No se pudo ajustar la seccion: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleSectionResizePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (sectionResizeDragRef.current?.pointerId !== event.pointerId) {
      return;
    }

    updateSectionResizeDragState(null);
  };

  const handleApplySectionChanges = async () => {
    if (!selectedSection) {
      return;
    }

    const parsedStart = Number(sectionStartDraft);
    const parsedEnd = Number(sectionEndDraft);
    if (Number.isNaN(parsedStart) || Number.isNaN(parsedEnd)) {
      setStatus("El rango de la seccion no es valido.");
      return;
    }

    setIsBusy(true);

    try {
      const nextSnapshot = await updateSection({
        sectionId: selectedSection.id,
        name: sectionNameDraft,
        startSeconds: parsedStart,
        endSeconds: parsedEnd,
      });
      const updatedSection =
        nextSnapshot.song?.sections.find((section) => section.id === selectedSection.id) ?? null;

      setSnapshot(nextSnapshot);
      setSectionDraft(null);
      setSelectedSectionId(selectedSection.id);
      setJumpTargetSectionId(selectedSection.id);
      setStatus(`Seccion actualizada: ${updatedSection?.name ?? sectionNameDraft.trim()}.`);
    } catch (error) {
      setStatus(`No se pudo actualizar la seccion: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDeleteSelectedSection = async () => {
    if (!selectedSection) {
      return;
    }

    setIsBusy(true);

    try {
      const deletedSectionName = selectedSection.name;
      const nextSnapshot = await deleteSection(selectedSection.id);
      const fallbackSectionId = nextSnapshot.song?.sections[0]?.id ?? null;

      setSnapshot(nextSnapshot);
      setSelectedSectionId(null);
      setSectionDraft(null);
      setJumpTargetSectionId(fallbackSectionId);
      setStatus(`Seccion eliminada: ${deletedSectionName}.`);
    } catch (error) {
      setStatus(`No se pudo borrar la seccion: ${String(error)}`);
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

  const autoScrollTimeline = (clientX: number) => {
    const scrollElement = timelineScrollRef.current;
    if (!scrollElement) {
      return;
    }

    const scrollRect = scrollElement.getBoundingClientRect();
    const edgeThreshold = 88;
    const maxScrollStep = 36;

    if (clientX <= scrollRect.left + edgeThreshold) {
      const intensity = clamp((scrollRect.left + edgeThreshold - clientX) / edgeThreshold, 0, 1);
      scrollElement.scrollLeft = Math.max(0, scrollElement.scrollLeft - maxScrollStep * intensity);
      return;
    }

    if (clientX >= scrollRect.right - edgeThreshold) {
      const intensity = clamp((clientX - (scrollRect.right - edgeThreshold)) / edgeThreshold, 0, 1);
      scrollElement.scrollLeft += maxScrollStep * intensity;
    }
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
    autoScrollTimeline(event.clientX);
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

  const handleTimelineWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) {
      return;
    }

    event.preventDefault();
    const zoomDelta = event.deltaY < 0 ? TIMELINE_ZOOM_STEP : -TIMELINE_ZOOM_STEP;
    updateTimelineZoom(zoomLevel + zoomDelta, event.clientX);
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

    autoScrollTimeline(event.clientX);
    const deltaSeconds = resolveTimelineSeconds(event.clientX) - currentDrag.pointerStartSeconds;
    const nextTimelineStartSeconds = Math.max(0, currentDrag.originTimelineStartSeconds + deltaSeconds);
    const nextClipDrag: ClipDragState = {
      ...currentDrag,
      previewTimelineStartSeconds: roundTimelineSeconds(snapTimelineSeconds(nextTimelineStartSeconds)),
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
      snapTimelineSeconds(Math.max(0, currentDrag.originTimelineStartSeconds + releaseDeltaSeconds)),
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

  const handleClipTrimPointerDown = (
    clip: ClipSummary,
    edge: "start" | "end",
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelectedSectionId(null);
    setSelectedClipId(clip.id);
    clipDragRef.current = null;
    setClipDrag(null);
    updateClipTrimDragState({
      clipId: clip.id,
      edge,
      pointerId: event.pointerId,
      previewTimelineStartSeconds: clip.timelineStartSeconds,
      previewSourceStartSeconds: clip.sourceStartSeconds,
      previewDurationSeconds: clip.durationSeconds,
    });
  };

  const handleClipTrimPointerMove = (
    clip: ClipSummary,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    autoScrollTimeline(event.clientX);
    updateClipTrimDragState((currentDrag) => {
      if (
        currentDrag === null ||
        currentDrag.pointerId !== event.pointerId ||
        currentDrag.clipId !== clip.id
      ) {
        return currentDrag;
      }

      const pointerSeconds = roundTimelineSeconds(resolveTimelineSeconds(event.clientX));
      if (!Number.isFinite(pointerSeconds)) {
        return currentDrag;
      }

      const clipEndSeconds = clip.timelineStartSeconds + clip.durationSeconds;
      if (currentDrag.edge === "start") {
        const minTimelineStart = Math.max(0, clip.timelineStartSeconds - clip.sourceStartSeconds);
        const nextTimelineStartSeconds = clamp(pointerSeconds, minTimelineStart, clipEndSeconds - 0.05);
        const timelineShift = nextTimelineStartSeconds - clip.timelineStartSeconds;

        return {
          ...currentDrag,
          previewTimelineStartSeconds: nextTimelineStartSeconds,
          previewSourceStartSeconds: roundTimelineSeconds(
            Math.max(0, clip.sourceStartSeconds + timelineShift),
          ),
          previewDurationSeconds: roundTimelineSeconds(
            Math.max(0.05, clipEndSeconds - nextTimelineStartSeconds),
          ),
        };
      }

      const nextClipEndSeconds = clamp(
        pointerSeconds,
        clip.timelineStartSeconds + 0.05,
        clipEndSeconds,
      );

      return {
        ...currentDrag,
        previewDurationSeconds: roundTimelineSeconds(
          Math.max(0.05, nextClipEndSeconds - clip.timelineStartSeconds),
        ),
      };
    });
  };

  const handleClipTrimPointerUp = async (
    clip: ClipSummary,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();

    const currentDrag = clipTrimDragRef.current;
    if (
      currentDrag === null ||
      currentDrag.pointerId !== event.pointerId ||
      currentDrag.clipId !== clip.id
    ) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    updateClipTrimDragState(null);
    setIsBusy(true);

    try {
      const nextSnapshot = await updateClipWindow({
        clipId: clip.id,
        timelineStartSeconds: roundTimelineSeconds(currentDrag.previewTimelineStartSeconds),
        sourceStartSeconds: roundTimelineSeconds(currentDrag.previewSourceStartSeconds),
        durationSeconds: roundTimelineSeconds(currentDrag.previewDurationSeconds),
      });
      setSnapshot(nextSnapshot);
      setSelectedClipId(clip.id);
      setStatus(`Clip ajustado: ${clipDisplayName(clip)}.`);
    } catch (error) {
      setStatus(`No se pudo ajustar el clip: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleClipTrimPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (clipTrimDragRef.current?.pointerId !== event.pointerId) {
      return;
    }

    updateClipTrimDragState(null);
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
                    max={TIMELINE_ZOOM_MAX}
                    min={TIMELINE_ZOOM_MIN}
                    step={TIMELINE_ZOOM_STEP}
                    type="range"
                    value={zoomLevel}
                    onChange={(event) => {
                      updateTimelineZoom(Number(event.target.value));
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

                <button
                  aria-pressed={snapEnabled}
                  className={snapEnabled ? "mode-toggle is-active" : "mode-toggle"}
                  disabled={isBusy || !song}
                  type="button"
                  onClick={() => {
                    setSnapEnabled((currentValue) => !currentValue);
                  }}
                >
                  {snapEnabled ? "Snap beat activo" : "Snap beat"}
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
                onWheel={handleTimelineWheel}
              >
                <div
                  ref={timelineContentRef}
                  className="timeline-content"
                  style={{ width: `${Math.max(zoomLevel * 100, 100)}%` }}
                >
                  <div className="timeline-ruler">
                    <div className="timeline-sections-layer">
                      {sections.map((section) => {
                        const renderedSection =
                          sectionResizeDrag?.sectionId === section.id
                            ? {
                                ...section,
                                startSeconds: sectionResizeDrag.previewStartSeconds,
                                endSeconds: sectionResizeDrag.previewEndSeconds,
                              }
                            : section;

                        return (
                          <div
                            className={`timeline-section-chip${
                              currentSection?.id === section.id ? " is-current" : ""
                            }${jumpTargetSectionId === section.id ? " is-target" : ""}${
                              selectedSectionId === section.id ? " is-selected" : ""
                            }${sectionResizeDrag?.sectionId === section.id ? " is-resizing" : ""}`}
                            key={section.id}
                            style={sectionStyle(renderedSection, durationSeconds)}
                          >
                            <button
                              aria-label={`Ajustar inicio de ${section.name}`}
                              className="timeline-section-handle is-start"
                              type="button"
                              onPointerCancel={handleSectionResizePointerCancel}
                              onPointerDown={(event) => {
                                handleSectionResizePointerDown(section, "start", event);
                              }}
                              onPointerMove={(event) => {
                                handleSectionResizePointerMove(section, event);
                              }}
                              onPointerUp={(event) => {
                                void handleSectionResizePointerUp(section, event);
                              }}
                            />
                            <button
                              aria-label={section.name}
                              aria-pressed={selectedSectionId === section.id}
                              className="timeline-section-body"
                              type="button"
                              onClick={() => {
                                setSelectedClipId(null);
                                setSelectedSectionId(section.id);
                                setJumpTargetSectionId(section.id);
                                setSectionDraft(null);
                              }}
                            >
                              <span>{section.name}</span>
                            </button>
                            <button
                              aria-label={`Ajustar fin de ${section.name}`}
                              className="timeline-section-handle is-end"
                              type="button"
                              onPointerCancel={handleSectionResizePointerCancel}
                              onPointerDown={(event) => {
                                handleSectionResizePointerDown(section, "end", event);
                              }}
                              onPointerMove={(event) => {
                                handleSectionResizePointerMove(section, event);
                              }}
                              onPointerUp={(event) => {
                                void handleSectionResizePointerUp(section, event);
                              }}
                            />
                          </div>
                        );
                      })}

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

                    {activeSectionResizePreview && (
                      <div
                        className="timeline-section-overlay is-resize-preview"
                        style={sectionStyle(activeSectionResizePreview, durationSeconds)}
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
                            const isTrimmedClip = clipTrimDrag?.clipId === clip.id;
                            const previewStartSeconds = isDraggedClip
                              ? clipDrag.previewTimelineStartSeconds
                              : clip.timelineStartSeconds;
                            const renderedClip =
                              clipTrimDrag?.clipId === clip.id
                                ? {
                                    ...clip,
                                    timelineStartSeconds: clipTrimDrag.previewTimelineStartSeconds,
                                    sourceStartSeconds: clipTrimDrag.previewSourceStartSeconds,
                                    durationSeconds: clipTrimDrag.previewDurationSeconds,
                                  }
                                : clip;

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

                                <div
                                  className={`clip-block${selectedClipId === clip.id ? " is-selected" : ""}${
                                    isDraggedClip ? " is-drag-source" : ""
                                  }${isTrimmedClip ? " is-trimming" : ""}`}
                                  style={clipStyle(renderedClip, durationSeconds)}
                                >
                                  <button
                                    aria-label={`Recortar inicio de ${clipDisplayName(clip)}`}
                                    className="clip-handle is-start"
                                    type="button"
                                    onPointerCancel={handleClipTrimPointerCancel}
                                    onPointerDown={(event) => {
                                      handleClipTrimPointerDown(clip, "start", event);
                                    }}
                                    onPointerMove={(event) => {
                                      handleClipTrimPointerMove(clip, event);
                                    }}
                                    onPointerUp={(event) => {
                                      void handleClipTrimPointerUp(clip, event);
                                    }}
                                  />
                                  <button
                                    aria-label={`Clip ${clipDisplayName(clip)}`}
                                    aria-pressed={selectedClipId === clip.id}
                                    className="clip-body"
                                    title={`${clipDisplayName(clip)} | ${formatClock(
                                      previewStartSeconds,
                                    )} / ${formatClock(renderedClip.durationSeconds)}`}
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
                                    <ClipFace clip={renderedClip} />
                                  </button>
                                  <button
                                    aria-label={`Recortar fin de ${clipDisplayName(clip)}`}
                                    className="clip-handle is-end"
                                    type="button"
                                    onPointerCancel={handleClipTrimPointerCancel}
                                    onPointerDown={(event) => {
                                      handleClipTrimPointerDown(clip, "end", event);
                                    }}
                                    onPointerMove={(event) => {
                                      handleClipTrimPointerMove(clip, event);
                                    }}
                                    onPointerUp={(event) => {
                                      void handleClipTrimPointerUp(clip, event);
                                    }}
                                  />
                                </div>
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
                    Inicio{" "}
                    {formatClock(
                      activeClipTrimPreview && clipTrimDrag?.clipId === selectedClip.id
                        ? activeClipTrimPreview.timelineStartSeconds
                        : clipDrag?.clipId === selectedClip.id
                          ? clipDrag.previewTimelineStartSeconds
                          : selectedClip.timelineStartSeconds,
                    )}
                    {" | "}Duracion{" "}
                    {formatClock(
                      activeClipTrimPreview && clipTrimDrag?.clipId === selectedClip.id
                        ? activeClipTrimPreview.durationSeconds
                        : selectedClip.durationSeconds,
                    )}{" "}
                    | Gain{" "}
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
                    <label className="compact-field">
                      <span>Entrada fuente (s)</span>
                      <input
                        aria-label="Entrada del clip en segundos"
                        disabled={isBusy}
                        min="0"
                        step="0.01"
                        type="number"
                        value={clipSourceStartDraft}
                        onChange={(event) => {
                          setClipSourceStartDraft(event.target.value);
                        }}
                      />
                    </label>
                    <label className="compact-field">
                      <span>Duracion (s)</span>
                      <input
                        aria-label="Duracion del clip en segundos"
                        disabled={isBusy}
                        min="0.05"
                        step="0.01"
                        type="number"
                        value={clipDurationDraft}
                        onChange={(event) => {
                          setClipDurationDraft(event.target.value);
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
                    <button
                      disabled={isBusy}
                      type="button"
                      onClick={() => void handleApplyClipWindow()}
                    >
                      Aplicar clip
                    </button>
                    <button
                      disabled={isBusy}
                      type="button"
                      onClick={() => void handleDuplicateSelectedClip()}
                    >
                      Duplicar clip
                    </button>
                    <button
                      disabled={isBusy}
                      type="button"
                      onClick={() => void handleDeleteSelectedClip()}
                    >
                      Borrar clip
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
                  <div className="context-fields">
                    <label className="compact-field">
                      <span>Nombre</span>
                      <input
                        aria-label="Nombre de la seccion"
                        disabled={isBusy}
                        type="text"
                        value={sectionNameDraft}
                        onChange={(event) => {
                          setSectionNameDraft(event.target.value);
                        }}
                      />
                    </label>

                    <label className="compact-field">
                      <span>Inicio (s)</span>
                      <input
                        aria-label="Inicio de la seccion en segundos"
                        disabled={isBusy}
                        min="0"
                        step="0.01"
                        type="number"
                        value={sectionStartDraft}
                        onChange={(event) => {
                          setSectionStartDraft(event.target.value);
                        }}
                      />
                    </label>

                    <label className="compact-field">
                      <span>Fin (s)</span>
                      <input
                        aria-label="Fin de la seccion en segundos"
                        disabled={isBusy}
                        min="0"
                        step="0.01"
                        type="number"
                        value={sectionEndDraft}
                        onChange={(event) => {
                          setSectionEndDraft(event.target.value);
                        }}
                      />
                    </label>
                  </div>
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
                  disabled={!selectedSection || isBusy}
                  type="button"
                  onClick={() => void handleApplySectionChanges()}
                >
                  Aplicar cambios
                </button>
                <button
                  disabled={!selectedSection || isBusy}
                  type="button"
                  onClick={() => void handleDeleteSelectedSection()}
                >
                  Borrar seccion
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
          <svg
            className="clip-waveform-svg"
            preserveAspectRatio="none"
            viewBox="0 0 160 36"
          >
            <path
              className="clip-waveform-fill"
              d={buildWaveformAreaPath(clip.waveformPeaks, 160, 36)}
            />
            <path
              className="clip-waveform-line"
              d={buildWaveformLinePath(clip.waveformPeaks, 160, 36)}
            />
          </svg>
        ) : (
          <svg
            className="clip-waveform-svg is-empty"
            preserveAspectRatio="none"
            viewBox="0 0 160 36"
          >
            <path className="waveform-empty-line" d="M 0 18 L 160 18" />
          </svg>
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

function buildWaveformLinePath(peaks: number[], width: number, height: number) {
  if (peaks.length === 0) {
    return "";
  }

  const centerY = height / 2;
  const amplitude = height * 0.44;

  return peaks
    .map((peak, index) => {
      const ratio = peaks.length === 1 ? 0 : index / (peaks.length - 1);
      const x = Number((ratio * width).toFixed(2));
      const y = Number((centerY - clamp(peak, 0, 1) * amplitude).toFixed(2));
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function buildWaveformAreaPath(peaks: number[], width: number, height: number) {
  if (peaks.length === 0) {
    return "";
  }

  const centerY = height / 2;
  const amplitude = height * 0.44;
  const topPoints = peaks.map((peak, index) => {
    const ratio = peaks.length === 1 ? 0 : index / (peaks.length - 1);
    const x = Number((ratio * width).toFixed(2));
    const y = Number((centerY - clamp(peak, 0, 1) * amplitude).toFixed(2));
    return `${x} ${y}`;
  });
  const bottomPoints = [...peaks].reverse().map((peak, reverseIndex) => {
    const index = peaks.length - 1 - reverseIndex;
    const ratio = peaks.length === 1 ? 0 : index / (peaks.length - 1);
    const x = Number((ratio * width).toFixed(2));
    const y = Number((centerY + clamp(peak, 0, 1) * amplitude).toFixed(2));
    return `${x} ${y}`;
  });

  return `M ${topPoints[0]} L ${topPoints.slice(1).join(" L ")} L ${bottomPoints.join(" L ")} Z`;
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
  const nextBlockIndex =
    Math.floor(currentPositionSeconds / secondsPerBar / quantizedBars) + 1;
  return Number((nextBlockIndex * quantizedBars * secondsPerBar).toFixed(3));
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

function maybeSnapSeconds(totalSeconds: number, song: SongSummary | null, snapEnabled: boolean) {
  if (!snapEnabled || !song) {
    return Math.max(0, totalSeconds);
  }

  const beatStepSeconds = 60 / Math.max(song.bpm, 1);
  return Math.max(0, Math.round(totalSeconds / beatStepSeconds) * beatStepSeconds);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampZoomLevel(zoomLevel: number) {
  return clamp(Number(zoomLevel.toFixed(2)), TIMELINE_ZOOM_MIN, TIMELINE_ZOOM_MAX);
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

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
