import type {
  ClipSummary,
  SectionMarkerSummary,
  SongRegionSummary,
  SongView,
  TempoMarkerSummary,
  TimeSignatureMarkerSummary,
  TrackSummary,
} from "../desktopApi";
import type { ContextMenuAction } from "../types";

export type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

/** Lo que la barra tactil considera "lo seleccionado" ahora mismo. */
export type MobileSelectionTarget =
  | { kind: "none" }
  | { kind: "clips"; clips: ClipSummary[] }
  | { kind: "marker"; marker: SectionMarkerSummary }
  | { kind: "tempoMarker"; marker: TempoMarkerSummary }
  | { kind: "timeSignatureMarker"; marker: TimeSignatureMarkerSummary }
  | { kind: "region"; region: SongRegionSummary }
  | { kind: "track"; track: TrackSummary };

export type MobileSelectionInput = {
  song: SongView | null;
  selectedClipIds: string[];
  selectedSectionId: string | null;
  selectedRegionId: string | null;
  selectedTrackIds: string[];
  /** Marca de tempo/compas seleccionada desde la regla (paso 6). */
  selectedTempoMarkerId?: string | null;
  selectedTimeSignatureMarkerId?: string | null;
};

/**
 * Traduce los ids sueltos de la seleccion al objeto que el usuario cree tener
 * seleccionado.
 *
 * El orden NO es arbitrario. Clip, marca y pista se limpian entre si en el
 * store (`selectClip`, `selectSection`, `selectTrack`), asi que como mucho hay
 * uno vivo: el ultimo que se toco. La region vive en un `useState` aparte que
 * nadie limpia, asi que va al final —seria el unico que podria "ganarle" a algo
 * que el usuario acaba de tocar—. Las marcas de tempo y compas van primero
 * porque se seleccionan explicitamente desde la regla y no tocan nada mas.
 */
export function resolveMobileSelection(
  input: MobileSelectionInput,
): MobileSelectionTarget {
  const song = input.song;
  if (!song) {
    return { kind: "none" };
  }

  const tempoMarker = input.selectedTempoMarkerId
    ? song.tempoMarkers.find(
        (marker) => marker.id === input.selectedTempoMarkerId,
      )
    : undefined;
  if (tempoMarker) {
    return { kind: "tempoMarker", marker: tempoMarker };
  }

  const timeSignatureMarker = input.selectedTimeSignatureMarkerId
    ? song.timeSignatureMarkers.find(
        (marker) => marker.id === input.selectedTimeSignatureMarkerId,
      )
    : undefined;
  if (timeSignatureMarker) {
    return { kind: "timeSignatureMarker", marker: timeSignatureMarker };
  }

  const clips = input.selectedClipIds
    .map((id) => song.clips.find((clip) => clip.id === id))
    .filter((clip): clip is ClipSummary => Boolean(clip));
  if (clips.length > 0) {
    return { kind: "clips", clips };
  }

  const marker = input.selectedSectionId
    ? song.sectionMarkers.find((entry) => entry.id === input.selectedSectionId)
    : undefined;
  if (marker) {
    return { kind: "marker", marker };
  }

  const track = input.selectedTrackIds.length
    ? song.tracks.find((entry) => entry.id === input.selectedTrackIds[0])
    : undefined;
  if (track) {
    return { kind: "track", track };
  }

  const region = input.selectedRegionId
    ? song.regions.find((entry) => entry.id === input.selectedRegionId)
    : undefined;
  if (region) {
    return { kind: "region", region };
  }

  return { kind: "none" };
}

/**
 * Las MISMAS factories que alimentan el menu contextual del escritorio. Se pide
 * por interfaz estrecha en vez de por el objeto entero para que el test pueda
 * comparar ambas listas sin montar el panel.
 */
export type MobileSelectionMenus = {
  clipContextMenu: (clip: ClipSummary) => ContextMenuAction[];
  sectionContextMenu: (marker: SectionMarkerSummary) => ContextMenuAction[];
  tempoMarkerContextMenu: (marker: TempoMarkerSummary) => ContextMenuAction[];
  timeSignatureMarkerContextMenu: (
    marker: TimeSignatureMarkerSummary,
  ) => ContextMenuAction[];
  songRegionContextMenu: (region: SongRegionSummary) => ContextMenuAction[];
  trackContextMenu: (track: TrackSummary) => ContextMenuAction[];
};

export type MobileCreationHandlers = {
  /** Pide el TIPO de seccion y crea la marca ya tipificada en el cabezal. */
  onCreateSection: () => void;
  /** Igual, con el vocabulario de avisos (Build, All In, Drums In...). */
  onCreateCue: () => void;
  /** Abre el MISMO dialogo de importacion que la biblioteca. */
  onAddAudios: () => void;
};

export type MobileSelectionBarModel = {
  title: string;
  actions: ContextMenuAction[];
  /** Cuantos objetos van a recibir la accion; null cuando no aplica. */
  count: number | null;
};

/**
 * Lo que la barra tactil tiene que pintar para la seleccion actual.
 *
 * No reimplementa NADA: cada rama devuelve la lista que ya devuelve la factory
 * del menu contextual del escritorio, de modo que dedo y clic derecho no pueden
 * divergir. Lo unico propio es el estado sin seleccion, donde no hay menu
 * contextual equivalente que copiar: ahi ofrece las acciones de creacion, que
 * es lo que un usuario nuevo necesita ver.
 */
export function mobileSelectionBarModel(args: {
  target: MobileSelectionTarget;
  menus: MobileSelectionMenus;
  creation: MobileCreationHandlers;
  t: Translate;
}): MobileSelectionBarModel {
  const { target, menus, creation, t } = args;

  switch (target.kind) {
    case "clips":
      return {
        // La factory de clips ya se ocupa de la multiseleccion por dentro
        // (mira selectedClipIds), asi que basta con darle uno cualquiera.
        title: t("mobileSelectionActions.clips", {
          count: target.clips.length,
          defaultValue: "{{count}} clip(s)",
        }),
        actions: menus.clipContextMenu(target.clips[0]),
        count: target.clips.length,
      };
    case "marker":
      return {
        title: target.marker.name,
        actions: menus.sectionContextMenu(target.marker),
        count: null,
      };
    case "tempoMarker":
      return {
        title: t("mobileSelectionActions.tempoMarker", {
          bpm: target.marker.bpm.toFixed(2),
          defaultValue: "Tempo {{bpm}}",
        }),
        actions: menus.tempoMarkerContextMenu(target.marker),
        count: null,
      };
    case "timeSignatureMarker":
      return {
        title: t("mobileSelectionActions.timeSignatureMarker", {
          signature: target.marker.signature,
          defaultValue: "Compás {{signature}}",
        }),
        actions: menus.timeSignatureMarkerContextMenu(target.marker),
        count: null,
      };
    case "region":
      return {
        title: target.region.name,
        actions: menus.songRegionContextMenu(target.region),
        count: null,
      };
    case "track":
      return {
        title: target.track.name,
        actions: menus.trackContextMenu(target.track),
        count: null,
      };
    case "none":
      return {
        title: t("mobileSelectionActions.create", { defaultValue: "Añadir" }),
        // La marca nace ya tipificada y nombrada: un toque mas al crearla, y a
        // cambio no deja trabajo pendiente ni sesiones llenas de marcas sin
        // tipo. Seccion y aviso van separados porque son vocabularios
        // distintos —la seccion anuncia con conteo, el aviso no— y preguntar
        // por el grupo en el gesto mas repetido del montaje sobra.
        actions: [
          {
            label: t("mobileSelectionActions.addSection", {
              defaultValue: "Sección",
            }),
            onSelect: creation.onCreateSection,
          },
          {
            label: t("mobileSelectionActions.addCue", {
              defaultValue: "Aviso",
            }),
            onSelect: creation.onCreateCue,
          },
          {
            label: t("mobileSelectionActions.addAudio", {
              defaultValue: "Audio",
            }),
            onSelect: creation.onAddAudios,
          },
        ],
        count: null,
      };
  }
}
