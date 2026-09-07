import type { ContextMenuAction } from "../types";
import type { TrackSummary } from "../desktopApi";
import { createTrack, moveTrack } from "../desktopApi";
import { isTrackDescendant } from "../helpers";
import { promptDialog } from "../../../shared/dialog/dialogService";
import type { TimelineMenuDeps } from "./timelineMenus";

/**
 * Meter y sacar pistas de carpetas desde el menu, sin arrastrar.
 *
 * Arrastrando, "dentro de la carpeta" es el 40% central de la fila de una
 * carpeta: con un raton se acierta, con un dedo es una moneda al aire entre
 * dejarla dentro o encima. Y con varias pistas seleccionadas habia que
 * repetir el arrastre una por una.
 *
 * Sale de `timelineMenus.ts` por tamano: ese fichero estaba a once lineas de
 * su presupuesto. Mismo patron que `markerKindMenus.ts`.
 */
export function createTrackFolderMenus(
  getDeps: () => TimelineMenuDeps,
  bumpContextMenuPosition: () => { x: number; y: number },
) {
  /** Carpetas a las que TIENE sentido mover esta seleccion. */
  function candidateFolders(tracks: TrackSummary[]): TrackSummary[] {
    const song = getDeps().songRef.current;
    if (!song) {
      return [];
    }
    const selected = new Set(tracks.map((track) => track.id));
    return song.tracks.filter(
      (candidate) =>
        candidate.kind === "folder" &&
        // Ni ella misma ni una carpeta que cuelgue de lo seleccionado: mover
        // una pista dentro de su propia descendencia deja el arbol roto.
        !selected.has(candidate.id) &&
        !tracks.some((track) =>
          isTrackDescendant(song, candidate.id, track.id),
        ),
    );
  }

  /** Mueve toda la seleccion a `parentTrackId` en una sola accion. */
  async function moveTracksInto(
    tracks: TrackSummary[],
    parentTrackId: string,
    folderName: string,
  ) {
    const d = getDeps();
    await d.runAction(async () => {
      let snapshot = null;
      for (const track of tracks) {
        snapshot = await moveTrack({ trackId: track.id, parentTrackId });
      }
      if (snapshot) {
        d.applyPlaybackSnapshot(snapshot);
      }
      await d.refreshSongView();
      d.setStatus(
        d.t("transport.status.tracksMovedIntoFolder", {
          count: tracks.length,
          name: folderName,
          defaultValue: "{{count}} pistas movidas a {{name}}.",
        }),
      );
    });
  }

  /**
   * Crea una carpeta y mete dentro la seleccion.
   *
   * El id de la carpeta nueva se saca comparando los ids ANTES y DESPUES:
   * `createTrack` devuelve un snapshot del transporte, no la pista creada, y
   * buscarla por nombre fallaria en cuanto haya dos carpetas homonimas.
   */
  async function createFolderWithTracks(tracks: TrackSummary[]) {
    const d = getDeps();
    const name = (
      await promptDialog(
        d.t("transport.prompt.trackName"),
        d.t("transport.defaults.folderTrackName"),
      )
    )?.trim();
    if (!name) {
      return;
    }

    const before = new Set(
      (d.songRef.current?.tracks ?? []).map((track) => track.id),
    );
    await d.runAction(async () => {
      const created = await createTrack({
        name,
        kind: "folder",
        insertAfterTrackId: tracks[0]?.id ?? null,
        parentTrackId: tracks[0]?.parentTrackId ?? null,
      });
      d.optimisticallyAppliedRevisionsRef.current.add(created.projectRevision);
      d.applyPlaybackSnapshot(created);
      await d.refreshSongView({ includeWaveforms: false, sync: true });
    });

    const folderId = (d.songRef.current?.tracks ?? []).find(
      (track) => track.kind === "folder" && !before.has(track.id),
    )?.id;
    if (!folderId) {
      d.setStatus(
        d.t("transport.status.folderNotCreated", {
          defaultValue: "No se pudo crear la carpeta.",
        }),
      );
      return;
    }
    await moveTracksInto(tracks, folderId, name);
  }

  function openMoveToFolderMenu(tracks: TrackSummary[]) {
    const d = getDeps();
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: d.t("transport.menu.moveToFolder", {
        defaultValue: "Mover a carpeta…",
      }),
      actions: [
        {
          label: d.t("transport.menu.newFolder", {
            defaultValue: "Carpeta nueva…",
          }),
          onSelect: () => void createFolderWithTracks(tracks),
        },
        ...candidateFolders(tracks).map((folder) => ({
          label: folder.name,
          onSelect: () => void moveTracksInto(tracks, folder.id, folder.name),
        })),
      ],
    });
  }

  /** Saca la seleccion de su carpeta, cada pista al nivel de su padre. */
  async function removeTracksFromFolder(tracks: TrackSummary[]) {
    const d = getDeps();
    const song = d.songRef.current;
    const nested = tracks.filter((track) => track.parentTrackId);
    if (!song || nested.length === 0) {
      return;
    }
    await d.runAction(async () => {
      let snapshot = null;
      for (const track of nested) {
        const parent = song.tracks.find(
          (candidate) => candidate.id === track.parentTrackId,
        );
        snapshot = await moveTrack({
          trackId: track.id,
          insertAfterTrackId: track.parentTrackId ?? null,
          parentTrackId: parent?.parentTrackId ?? null,
        });
      }
      if (snapshot) {
        d.applyPlaybackSnapshot(snapshot);
      }
      await d.refreshSongView();
      d.setStatus(
        d.t("transport.status.tracksRemovedFromFolder", {
          count: nested.length,
          defaultValue: "{{count}} pistas fuera de su carpeta.",
        }),
      );
    });
  }

  /** Las dos entradas que se cuelgan del menu de varias pistas. */
  function folderActions(tracks: TrackSummary[]): ContextMenuAction[] {
    const d = getDeps();
    return [
      {
        label: d.t("transport.menu.moveToFolder", {
          defaultValue: "Mover a carpeta…",
        }),
        onSelect: () => openMoveToFolderMenu(tracks),
      },
      {
        label: d.t("transport.menu.removeFromFolder"),
        disabled: !tracks.some((track) => track.parentTrackId),
        onSelect: () => void removeTracksFromFolder(tracks),
      },
    ];
  }

  return { folderActions, candidateFolders };
}
