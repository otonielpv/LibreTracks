import {
  buildSongTempoRegions,
  getSongBaseBpm,
  getSongBaseTimeSignature,
  type SongView,
  type TransportSnapshot,
} from "@libretracks/shared/models";

import { createClipsWithAutoTracks } from "../desktopApi";
import { nextDownbeatAfter } from "../timeline/timelineMath";
import type { LibraryAssetDragPayload, LibraryDropLayout } from "../types";

/**
 * Llevar audios de la biblioteca al timeline SIN puntero.
 *
 * En escritorio esto se hace arrastrando: el punto de destino lo pone el ratón.
 * En móvil no hay arrastre viable (compite con el desplazamiento del panel, y
 * en vertical la biblioteca tapa el timeline entero), así que las mismas
 * acciones entran por botón o por menú — y entonces hay que DECIDIR dónde caen.
 * Esa decisión es lo que vive aquí, junto al resto de reglas de colocación,
 * en vez de en el monolito del panel.
 */

export type LibraryPlacementDeps = {
  t: (key: string, options?: Record<string, unknown>) => string;
  /** Canción viva. Se lee por getter: la factoría se crea una sola vez. */
  getSong: () => SongView | null;
  /** Reloj visual del panel: el cabezal tal y como lo ve el usuario. */
  getPlayheadSeconds: () => number;
  runAction: (action: () => Promise<void>) => void;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  /** El mismo `dropLibraryFolder` que usa el arrastre de la cabecera de una
   * carpeta, para que las dos vías creen exactamente la misma canción. */
  dropFolder: (args: {
    payload: LibraryAssetDragPayload[];
    folderName: string;
    timelineStartSeconds: number;
    layout: LibraryDropLayout;
  }) => Promise<void>;
};

/**
 * Dónde empieza la canción que nace de una carpeta.
 *
 * Al FINAL del proyecto, en el primer tiempo fuerte libre — la misma regla que
 * la importación de un `.ltpkg`— y no en el cabezal. Una carpeta se convierte en
 * una canción ENTERA: soltarla sobre el cabezal chocaría con la canción que ya
 * estuviera ahí y lo único que conseguiría el usuario sería un aviso de
 * colisión. El primer proyecto vacío ancla en 0, sin silencio inicial.
 */
export function resolveFolderSongAnchorSeconds(song: SongView): number {
  if (!song.regions.length) {
    return 0;
  }
  const lastEnd = song.regions.reduce(
    (acc, region) => Math.max(acc, region.endSeconds),
    0,
  );
  return nextDownbeatAfter(
    lastEnd,
    getSongBaseBpm(song),
    getSongBaseTimeSignature(song),
    buildSongTempoRegions(song),
  );
}

export function createLibraryPlacementHandlers(
  getDeps: () => LibraryPlacementDeps,
) {
  /** Selección suelta → un clip por audio en el cabezal, cada uno en su pista
   * nueva. Es el "Añadir al timeline" de la barra de acciones móvil. */
  function addAssetsAtPlayhead(payload: Array<{ filePath: string }>) {
    const deps = getDeps();
    if (payload.length === 0) return;
    const startSeconds = deps.getPlayheadSeconds();
    deps.runAction(async () => {
      deps.applyPlaybackSnapshot(
        await createClipsWithAutoTracks(
          payload.map((item) => ({
            filePath: item.filePath,
            timelineStartSeconds: startSeconds,
          })),
        ),
      );
      deps.setStatus(
        deps.t("library.addedToTimeline", {
          count: payload.length,
          defaultValue: "{{count}} audios añadidos al timeline",
        }),
      );
    });
  }

  /** Vista compacta: audios soltados sobre una canción concreta entran por su
   * inicio, no por el cabezal — ahí el usuario apunta a la canción. */
  function addAssetsToSong(
    regionId: string,
    payload: Array<{ filePath: string; durationSeconds?: number }>,
  ) {
    const deps = getDeps();
    const region = deps.getSong()?.regions.find((item) => item.id === regionId);
    if (!region || payload.length === 0) return;
    deps.runAction(async () => {
      deps.applyPlaybackSnapshot(
        await createClipsWithAutoTracks(
          payload.map((item) => ({
            filePath: item.filePath,
            timelineStartSeconds: region.startSeconds,
          })),
        ),
      );
    });
  }

  /**
   * "Una carpeta, una canción" desde el menú de la biblioteca.
   *
   * `vertical` = una pista nueva por audio: una carpeta de stems es
   * precisamente eso, no una sucesión de clips en la misma pista.
   */
  function addFolderToTimeline(
    folderPath: string | null,
    folderAssets: Array<{ filePath: string; durationSeconds: number }>,
  ) {
    const deps = getDeps();
    const song = deps.getSong();
    if (!song) return;
    const timelineStartSeconds = resolveFolderSongAnchorSeconds(song);
    deps.runAction(() =>
      deps.dropFolder({
        payload: folderAssets.map((asset) => ({
          file_path: asset.filePath,
          durationSeconds: asset.durationSeconds,
        })),
        folderName: folderPath ?? deps.t("library.rootFolder"),
        timelineStartSeconds,
        layout: "vertical",
      }),
    );
  }

  return { addAssetsAtPlayhead, addAssetsToSong, addFolderToTimeline };
}
