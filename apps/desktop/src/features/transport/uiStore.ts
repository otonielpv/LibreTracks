import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { recordProductEvent } from "../telemetry/telemetry";
import type { RulerMarkerRef } from "@libretracks/shared/desktopApi";

export type GlobalJumpMode = "immediate" | "after_bars" | "next_marker" | "next_section" | "next_cue";
export type SongJumpTrigger =
  | "immediate"
  | "region_end"
  | "after_bars"
  | "next_marker"
  | "next_section"
  | "next_cue";
export type SongTransitionMode = "instant" | "fade_out";
export type VampMode = "section" | "section_marker" | "cue" | "bars";

/** Top-level view mode: linear DAW, song-grid Compact, or stage-ready Live. */
export type ViewMode = "daw" | "setlist" | "compact" | "live";

/** Tab order of the views; Shift+Tab walks it backwards. */
export const VIEW_MODE_CYCLE: readonly ViewMode[] = [
  "daw",
  "setlist",
  "compact",
  "live",
];

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
  selectedMarkers: [] as RulerMarkerRef[],
};

const CLEAR_RULER_MARKERS = {
  selectedTempoMarkerId: null as string | null,
  selectedTimeSignatureMarkerId: null as string | null,
  selectedMarkers: [] as RulerMarkerRef[],
};

/**
 * Las marcas seleccionadas, de cualquier tipo.
 *
 * Con UNA marca la verdad siguen siendo los campos sueltos de siempre
 * (`selectedSectionId`, `selectedTempoMarkerId`, ...), que es lo que lee todo
 * el codigo de antes; `selectedMarkers` solo se llena con una seleccion
 * multiple. Leer siempre por aqui evita tener que mirar los dos sitios.
 */
export function selectedRulerMarkers(state: {
  selectedMarkers: RulerMarkerRef[];
  selectedSectionId: string | null;
  selectedTempoMarkerId: string | null;
  selectedTimeSignatureMarkerId: string | null;
}): RulerMarkerRef[] {
  if (state.selectedMarkers.length > 0) return state.selectedMarkers;
  if (state.selectedSectionId) return [{ kind: "section", id: state.selectedSectionId }];
  if (state.selectedTempoMarkerId) return [{ kind: "tempo", id: state.selectedTempoMarkerId }];
  if (state.selectedTimeSignatureMarkerId) {
    return [{ kind: "timeSignature", id: state.selectedTimeSignatureMarkerId }];
  }
  return [];
}

function sameMarker(a: RulerMarkerRef, b: RulerMarkerRef) {
  return a.kind === b.kind && a.id === b.id;
}

/** Una seleccion de marcas como campos del store: con una sola, los campos
 * sueltos de siempre; con varias, la lista. */
function markerSelectionFields(markers: RulerMarkerRef[]) {
  if (markers.length === 1) {
    const [only] = markers;
    return {
      ...EMPTY_SELECTION,
      selectedSectionId: only.kind === "section" ? only.id : null,
      selectedTempoMarkerId: only.kind === "tempo" ? only.id : null,
      selectedTimeSignatureMarkerId:
        only.kind === "timeSignature" ? only.id : null,
    };
  }
  return { ...EMPTY_SELECTION, selectedMarkers: markers };
}

/**
 * La altura global de las pistas es una preferencia de la instalación, como el
 * zoom de la interfaz: se guarda en localStorage para que sobreviva a cerrar y
 * abrir la app. Las alturas por pista ya viajan en el proyecto (offsets).
 */
const TRACK_HEIGHT_STORAGE_KEY = "lt.timeline.trackHeight";

function readStoredTrackHeight(): number {
  try {
    const raw = window.localStorage.getItem(TRACK_HEIGHT_STORAGE_KEY);
    if (raw === null) return TIMELINE_DEFAULT_TRACK_HEIGHT;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : TIMELINE_DEFAULT_TRACK_HEIGHT;
  } catch {
    return TIMELINE_DEFAULT_TRACK_HEIGHT;
  }
}

function storeTrackHeight(trackHeight: number): void {
  try {
    window.localStorage.setItem(TRACK_HEIGHT_STORAGE_KEY, String(trackHeight));
  } catch {
    // Sin almacenamiento (modo privado, cuota): la altura vale para esta sesión.
  }
}

function recordViewMode(viewMode: ViewMode): void {
  // `feature_setlist_view` is not in the closed list of the telemetry table
  // (D1 CHECK) nor in the website Functions yet: it would be rejected. Step 19
  // of docs/plans/setlist-view adds the migration and starts emitting it.
  if (viewMode === "setlist") return;
  recordProductEvent(`feature_${viewMode}_view`);
}

function stepViewMode(current: ViewMode, step: 1 | -1): ViewMode {
  const index = VIEW_MODE_CYCLE.indexOf(current);
  const length = VIEW_MODE_CYCLE.length;
  return VIEW_MODE_CYCLE[(index + step + length) % length];
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
  /** Seleccion MULTIPLE de marcas de la regla (de cualquier tipo). Vacia con
   * una sola: ver `selectedRulerMarkers`. */
  selectedMarkers: RulerMarkerRef[];
  /** Desde donde cuenta Shift+clic: la ultima marca elegida sola o con Ctrl. */
  markerSelectionAnchor: RulerMarkerRef | null;
  snapEnabled: boolean;
  followPlayheadEnabled: boolean;
  midiLearnMode: string | null;
  trackReorderMode: boolean;
  /** Marca cuya posición se está corrigiendo a mano; null con el editor cerrado. */
  markerPositionEditorId: string | null;
  /** Móvil: pista cuya fila está desplegada con sus controles; null si ninguna. */
  expandedTrackId: string | null;
  /**
   * Móvil: el panel de mezcla que abre la barra de la selección.
   *
   * Vive aquí y no en la barra porque es EXCLUYENTE con la fila desplegada de
   * una cabecera: son el mismo panel: con una sola pista seleccionada salían
   * los dos, uno debajo del otro.
   */
  selectionMixOpen: boolean;
  /**
   * Móvil: selección por área. Un dedo dibuja un recuadro (en las cabeceras
   * coge pistas; en los carriles, clips) y los toques sueltos SUMAN o quitan en
   * vez de reemplazar. Con un dedo no hay Ctrl ni Shift que mantener: sin esto
   * juntar varias pistas era tocarlas una a una. Ver mobile/areaSelection.ts.
   */
  areaSelectMode: boolean;
  viewMode: ViewMode;
  /** Where «‹ Back» in the DAW goes (Setlist's «Open in the DAW»). Any other
   * change of view clears it. */
  returnViewMode: ViewMode | null;
  setReturnViewMode: (mode: ViewMode | null) => void;
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
  /** Sustituye la seleccion por estas marcas. `anchor` fija desde donde cuenta
   * el siguiente Shift+clic; sin el, se queda el que habia. */
  setSelectedMarkers: (markers: RulerMarkerRef[], anchor?: RulerMarkerRef) => void;
  /** Ctrl+clic: pone o quita una marca, y pasa a ser el ancla. */
  toggleMarkerSelection: (marker: RulerMarkerRef) => void;
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
  setAreaSelectMode: (enabled: boolean) => void;
  toggleTrackSelection: (trackId: string) => void;
  setExpandedTrackId: (trackId: string | null) => void;
  setSelectionMixOpen: (open: boolean) => void;
  /**
   * La pantalla de "archivos que faltan" está abierta.
   *
   * Vive en el store y no en `TransportPanelContent` para no añadirle estado
   * (regla 8 del plan de feedback de testers): el monolito sólo lee el
   * selector y pinta el componente.
   */
  missingMediaOpen: boolean;
  setMissingMediaOpen: (open: boolean) => void;
};

export const useTimelineUIStore = create<TimelineUIState>()(
  subscribeWithSelector((set, get) => ({
    cameraX: 0,
    zoomLevel: TIMELINE_DEFAULT_ZOOM_LEVEL,
    trackHeight:
      typeof window === "undefined"
        ? TIMELINE_DEFAULT_TRACK_HEIGHT
        : readStoredTrackHeight(),
    selectedTrackIds: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedSectionId: null,
    selectedTempoMarkerId: null,
    selectedTimeSignatureMarkerId: null,
    selectedMarkers: [],
    markerSelectionAnchor: null,
    snapEnabled: TIMELINE_DEFAULT_SNAP_ENABLED,
    followPlayheadEnabled: TIMELINE_DEFAULT_FOLLOW_PLAYHEAD_ENABLED,
    midiLearnMode: null,
    trackReorderMode: false,
    markerPositionEditorId: null,
    expandedTrackId: null,
    selectionMixOpen: false,
    missingMediaOpen: false,
    areaSelectMode: false,
    viewMode: DEFAULT_VIEW_MODE,
    returnViewMode: null,
    setReturnViewMode: (returnViewMode) => set({ returnViewMode }),
    setViewMode: (viewMode) => {
      recordViewMode(viewMode);
      set({ viewMode, returnViewMode: null });
    },
    toggleViewMode: () => {
      set((state) => {
        const viewMode = stepViewMode(state.viewMode, 1);
        recordViewMode(viewMode);
        return { viewMode, returnViewMode: null };
      });
    },
    toggleViewModeBackward: () => {
      set((state) => {
        const viewMode = stepViewMode(state.viewMode, -1);
        recordViewMode(viewMode);
        return { viewMode, returnViewMode: null };
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
      const previous = get().trackHeight;
      set((state) => ({
        trackHeight:
          typeof trackHeight === "function" ? trackHeight(state.trackHeight) : trackHeight,
      }));
      const next = get().trackHeight;
      if (next !== previous && Number.isFinite(next)) {
        storeTrackHeight(next);
      }
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
        markerSelectionAnchor: selectedTempoMarkerId
          ? { kind: "tempo", id: selectedTempoMarkerId }
          : null,
      });
    },
    selectTimeSignatureMarker: (selectedTimeSignatureMarkerId) => {
      set({
        ...EMPTY_SELECTION,
        selectedTimeSignatureMarkerId,
        markerSelectionAnchor: selectedTimeSignatureMarkerId
          ? { kind: "timeSignature", id: selectedTimeSignatureMarkerId }
          : null,
      });
    },
    setSelectedMarkers: (markers, anchor) => {
      set((state) => ({
        ...markerSelectionFields(markers),
        markerSelectionAnchor: anchor ?? state.markerSelectionAnchor,
      }));
    },
    toggleMarkerSelection: (marker) => {
      set((state) => {
        const current = selectedRulerMarkers(state);
        const next = current.some((entry) => sameMarker(entry, marker))
          ? current.filter((entry) => !sameMarker(entry, marker))
          : [...current, marker];
        return { ...markerSelectionFields(next), markerSelectionAnchor: marker };
      });
    },
    clearSelection: () => {
      // Soltar la seleccion sale tambien de los modos de sumar: si no, el
      // siguiente toque volveria a sumar sin que nadie lo haya pedido.
      set({ ...EMPTY_SELECTION, areaSelectMode: false, markerSelectionAnchor: null });
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
        state.selectedTimeSignatureMarkerId === null &&
        state.selectedMarkers.length === 0
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
        markerSelectionAnchor: sectionId ? { kind: "section", id: sectionId } : null,
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
      set((state) => ({
        trackReorderMode,
        areaSelectMode: trackReorderMode ? false : state.areaSelectMode,
      }));
    },
    toggleTrackReorderMode: () => {
      set((state) => ({
        trackReorderMode: !state.trackReorderMode,
        areaSelectMode: state.trackReorderMode ? state.areaSelectMode : false,
      }));
    },
    setMarkerPositionEditorId: (markerPositionEditorId) => {
      set({ markerPositionEditorId });
    },
    // Una sola fila desplegada a la vez: son controles a tamaño de dedo y dos
    // abiertas se taparían entre ellas. Y el panel de mezcla de la barra es esa
    // misma fila para la selección, así que tampoco puede convivir con ella.
    toggleExpandedTrackId: (trackId) => {
      set((state) => {
        const expandedTrackId =
          state.expandedTrackId === trackId ? null : trackId;
        return {
          expandedTrackId,
          selectionMixOpen: expandedTrackId ? false : state.selectionMixOpen,
        };
      });
    },
    setExpandedTrackId: (expandedTrackId) => {
      set((state) => ({
        expandedTrackId,
        selectionMixOpen: expandedTrackId ? false : state.selectionMixOpen,
      }));
    },
    setMissingMediaOpen: (missingMediaOpen) => set({ missingMediaOpen }),
    setSelectionMixOpen: (selectionMixOpen) => {
      set((state) => ({
        selectionMixOpen,
        expandedTrackId: selectionMixOpen ? null : state.expandedTrackId,
      }));
    },
    // Excluyente con reordenar: los dos se quedan el arrastre de un dedo
    // sobre las cabeceras.
    setAreaSelectMode: (areaSelectMode) => {
      set((state) => ({
        areaSelectMode,
        trackReorderMode: areaSelectMode ? false : state.trackReorderMode,
      }));
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
