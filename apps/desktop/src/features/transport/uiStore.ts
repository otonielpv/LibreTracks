import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { recordProductEvent } from "../telemetry/telemetry";

export type GlobalJumpMode = "immediate" | "after_bars" | "next_marker";
export type SongJumpTrigger =
  | "immediate"
  | "region_end"
  | "after_bars"
  | "next_marker";
export type SongTransitionMode = "instant" | "fade_out";
export type VampMode = "section" | "bars";

/** Top-level view mode: linear DAW, song-grid Compact, or stage-ready Live. */
export type ViewMode = "daw" | "compact" | "live";

export const TIMELINE_DEFAULT_ZOOM_LEVEL = 7;
export const TIMELINE_DEFAULT_TRACK_HEIGHT = 76;
export const TIMELINE_DEFAULT_SNAP_ENABLED = true;
export const TIMELINE_DEFAULT_FOLLOW_PLAYHEAD_ENABLED = false;
export const DEFAULT_VIEW_MODE: ViewMode = "daw";

/**
 * Toda seleccion nueva apaga las demas. Vive en una constante porque son ya
 * seis campos y en ocho sitios: olvidar uno significa que la barra tactil
 * ensena las acciones de algo que el usuario dejo de tener seleccionado hace
 * rato.
 */
const EMPTY_SELECTION = {
  selectedTrackIds: [] as string[],
  selectedClipId: null as string | null,
  selectedClipIds: [] as string[],
  selectedSectionId: null as string | null,
  selectedTempoMarkerId: null as string | null,
  selectedTimeSignatureMarkerId: null as string | null,
};

const CLEAR_RULER_MARKERS = {
  selectedTempoMarkerId: null as string | null,
  selectedTimeSignatureMarkerId: null as string | null,
};

function recordViewMode(viewMode: ViewMode): void {
  recordProductEvent(`feature_${viewMode}_view`);
}

type TimelineUIState = {
  cameraX: number;
  zoomLevel: number;
  trackHeight: number;
  selectedTrackIds: string[];
  selectedClipId: string | null;
  selectedClipIds: string[];
  selectedSectionId: string | null;
  /** Marcas de la regla inferior. Sólo las selecciona la app móvil, donde son
   * la puerta a sus acciones; en escritorio siguen yendo por clic derecho. */
  selectedTempoMarkerId: string | null;
  selectedTimeSignatureMarkerId: string | null;
  snapEnabled: boolean;
  followPlayheadEnabled: boolean;
  midiLearnMode: string | null;
  trackReorderMode: boolean;
  /** Marca cuya posición se está corrigiendo a mano; null con el editor cerrado. */
  markerPositionEditorId: string | null;
  /** Móvil: pista cuya fila está desplegada con sus controles; null si ninguna. */
  expandedTrackId: string | null;
  /** Móvil: los toques en las cabeceras SUMAN a la selección en vez de
   * reemplazarla. Sin esto no hay forma de borrar varias pistas de un tirón
   * con un dedo: no hay Ctrl que mantener. */
  trackMultiSelect: boolean;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  toggleViewMode: () => void;
  toggleViewModeBackward: () => void;
  setCameraX: (cameraX: number) => void;
  setZoomLevel: (zoomLevel: number | ((currentZoomLevel: number) => number)) => void;
  setTrackHeight: (trackHeight: number | ((currentTrackHeight: number) => number)) => void;
  setSelectedTrackIds: (trackIds: string[]) => void;
  setSelectedClipId: (clipId: string | null) => void;
  setSelectedClipIds: (clipIds: string[]) => void;
  toggleClipSelection: (clipId: string) => void;
  setSelectedSectionId: (sectionId: string | null) => void;
  selectTempoMarker: (markerId: string | null) => void;
  selectTimeSignatureMarker: (markerId: string | null) => void;
  clearSelection: () => void;
  clearSelectionIfAny: () => void;
  selectTrack: (trackIds: string[]) => void;
  selectClip: (clipId: string | null, trackId?: string | null) => void;
  selectSection: (sectionId: string | null) => void;
  setSnapEnabled: (enabled: boolean | ((currentSnapEnabled: boolean) => boolean)) => void;
  toggleSnapEnabled: () => void;
  setFollowPlayheadEnabled: (
    enabled: boolean | ((currentFollowPlayheadEnabled: boolean) => boolean),
  ) => void;
  toggleFollowPlayheadEnabled: () => void;
  setMidiLearnMode: (midiLearnMode: string | null) => void;
  setTrackReorderMode: (enabled: boolean) => void;
  toggleTrackReorderMode: () => void;
  setMarkerPositionEditorId: (markerId: string | null) => void;
  toggleExpandedTrackId: (trackId: string) => void;
  setTrackMultiSelect: (enabled: boolean) => void;
  toggleTrackSelection: (trackId: string) => void;
  setExpandedTrackId: (trackId: string | null) => void;
};

export const useTimelineUIStore = create<TimelineUIState>()(
  subscribeWithSelector((set, get) => ({
    cameraX: 0,
    zoomLevel: TIMELINE_DEFAULT_ZOOM_LEVEL,
    trackHeight: TIMELINE_DEFAULT_TRACK_HEIGHT,
    selectedTrackIds: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedSectionId: null,
    selectedTempoMarkerId: null,
    selectedTimeSignatureMarkerId: null,
    snapEnabled: TIMELINE_DEFAULT_SNAP_ENABLED,
    followPlayheadEnabled: TIMELINE_DEFAULT_FOLLOW_PLAYHEAD_ENABLED,
    midiLearnMode: null,
    trackReorderMode: false,
    markerPositionEditorId: null,
    expandedTrackId: null,
    trackMultiSelect: false,
    viewMode: DEFAULT_VIEW_MODE,
    setViewMode: (viewMode) => {
      recordViewMode(viewMode);
      set({ viewMode });
    },
    toggleViewMode: () => {
      set((state) => {
        const viewMode: ViewMode =
          state.viewMode === "daw"
            ? "compact"
            : state.viewMode === "compact"
              ? "live"
              : "daw";
        recordViewMode(viewMode);
        return { viewMode };
      });
    },
    toggleViewModeBackward: () => {
      set((state) => {
        const viewMode: ViewMode =
          state.viewMode === "daw"
            ? "live"
            : state.viewMode === "live"
              ? "compact"
              : "daw";
        recordViewMode(viewMode);
        return { viewMode };
      });
    },
    setCameraX: (cameraX) => {
      set({ cameraX: Number.isFinite(cameraX) ? Math.max(0, cameraX) : 0 });
    },
    setZoomLevel: (zoomLevel) => {
      set((state) => ({
        zoomLevel:
          typeof zoomLevel === "function" ? zoomLevel(state.zoomLevel) : zoomLevel,
      }));
    },
    setTrackHeight: (trackHeight) => {
      set((state) => ({
        trackHeight:
          typeof trackHeight === "function" ? trackHeight(state.trackHeight) : trackHeight,
      }));
    },
    setSelectedTrackIds: (selectedTrackIds) => {
      set({
        selectedTrackIds,
        selectedClipId: null,
        selectedClipIds: [],
        ...CLEAR_RULER_MARKERS,
      });
    },
    setSelectedClipId: (selectedClipId) => {
      set({
        selectedClipId,
        selectedClipIds: selectedClipId ? [selectedClipId] : [],
        ...CLEAR_RULER_MARKERS,
      });
    },
    setSelectedClipIds: (selectedClipIds) => {
      set({
        selectedTrackIds: [],
        selectedClipId: selectedClipIds.at(-1) ?? null,
        selectedClipIds,
        selectedSectionId: null,
        ...CLEAR_RULER_MARKERS,
      });
    },
    toggleClipSelection: (clipId) => {
      set((state) => {
        const selectedClipIds = state.selectedClipIds.includes(clipId)
          ? state.selectedClipIds.filter((id) => id !== clipId)
          : [...state.selectedClipIds, clipId];
        return {
          selectedTrackIds: [],
          selectedClipId: selectedClipIds.at(-1) ?? null,
          selectedClipIds,
          selectedSectionId: null,
          ...CLEAR_RULER_MARKERS,
        };
      });
    },
    setSelectedSectionId: (selectedSectionId) => {
      set({ selectedSectionId, ...CLEAR_RULER_MARKERS });
    },
    selectTempoMarker: (selectedTempoMarkerId) => {
      set({
        ...EMPTY_SELECTION,
        selectedTempoMarkerId,
      });
    },
    selectTimeSignatureMarker: (selectedTimeSignatureMarkerId) => {
      set({
        ...EMPTY_SELECTION,
        selectedTimeSignatureMarkerId,
      });
    },
    clearSelection: () => {
      // Soltar la seleccion sale tambien del modo de sumar pistas: si no,
      // el siguiente toque en una cabecera volveria a sumar sin que nadie lo
      // haya pedido.
      set({ ...EMPTY_SELECTION, trackMultiSelect: false });
    },
    /** Como `clearSelection`, pero no toca el estado si no había nada
     * seleccionado. El fondo del timeline llama a esto en CADA clic de salto y
     * `clearSelection` publica arrays nuevos: sin la guarda, cada clic en el
     * hueco vacío re-renderizaría a todos los suscriptores de la selección. */
    clearSelectionIfAny: () => {
      const state = get();
      if (
        state.selectedTrackIds.length === 0 &&
        state.selectedClipIds.length === 0 &&
        state.selectedClipId === null &&
        state.selectedSectionId === null &&
        state.selectedTempoMarkerId === null &&
        state.selectedTimeSignatureMarkerId === null
      ) {
        return;
      }
      state.clearSelection();
    },
    selectTrack: (selectedTrackIds) => {
      set({
        ...EMPTY_SELECTION,
        selectedTrackIds,
      });
    },
    selectClip: (clipId, _trackId = null) => {
      set({
        ...EMPTY_SELECTION,
        selectedClipId: clipId,
        selectedClipIds: clipId ? [clipId] : [],
      });
    },
    selectSection: (sectionId) => {
      set({
        ...EMPTY_SELECTION,
        selectedSectionId: sectionId,
      });
    },
    setSnapEnabled: (snapEnabled) => {
      set((state) => ({
        snapEnabled:
          typeof snapEnabled === "function" ? snapEnabled(state.snapEnabled) : snapEnabled,
      }));
    },
    toggleSnapEnabled: () => {
      set((state) => ({ snapEnabled: !state.snapEnabled }));
    },
    setFollowPlayheadEnabled: (followPlayheadEnabled) => {
      set((state) => ({
        followPlayheadEnabled:
          typeof followPlayheadEnabled === "function"
            ? followPlayheadEnabled(state.followPlayheadEnabled)
            : followPlayheadEnabled,
      }));
    },
    toggleFollowPlayheadEnabled: () => {
      set((state) => ({
        followPlayheadEnabled: !state.followPlayheadEnabled,
      }));
    },
    setMidiLearnMode: (midiLearnMode) => {
      set({ midiLearnMode });
    },
    setTrackReorderMode: (trackReorderMode) => {
      set({ trackReorderMode });
    },
    toggleTrackReorderMode: () => {
      set((state) => ({ trackReorderMode: !state.trackReorderMode }));
    },
    setMarkerPositionEditorId: (markerPositionEditorId) => {
      set({ markerPositionEditorId });
    },
    // Una sola fila desplegada a la vez: son controles a tamaño de dedo y dos
    // abiertas se taparían entre ellas.
    toggleExpandedTrackId: (trackId) => {
      set((state) => ({
        expandedTrackId: state.expandedTrackId === trackId ? null : trackId,
      }));
    },
    setExpandedTrackId: (expandedTrackId) => {
      set({ expandedTrackId });
    },
    setTrackMultiSelect: (trackMultiSelect) => {
      set({ trackMultiSelect });
    },
    toggleTrackSelection: (trackId) => {
      set((state) => ({
        ...EMPTY_SELECTION,
        selectedTrackIds: state.selectedTrackIds.includes(trackId)
          ? state.selectedTrackIds.filter((id) => id !== trackId)
          : [...state.selectedTrackIds, trackId],
      }));
    },
  })),
);
