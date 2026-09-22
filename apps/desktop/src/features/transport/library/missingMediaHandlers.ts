import { open } from "@tauri-apps/plugin-dialog";

import type { TransportSnapshot } from "@libretracks/shared/models";
import {
  importStagedAudioFiles,
  isMobileApp,
  resolveMissingFile,
} from "@libretracks/shared/desktopApi";

import { pickFilesViaWebView, stageFileForImport } from "./mobileFilePicker";

/**
 * Volver a enlazar el audio que la sesión referencia y no está.
 *
 * Extraído de `TransportPanelContent` (el paso 08 del plan de feedback de
 * testers añadía un segundo manejador y el fichero rebasaba su presupuesto de
 * tamaño). Factory con inyección de dependencias, que es el patrón ya validado
 * en el repo — ver `tracks/trackHeaderHandlers.ts`.
 */
export type MissingMediaHandlerDeps = {
  runAction: (
    action: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot) => void;
  refreshSongView: () => Promise<unknown>;
  refreshLibraryState: () => Promise<unknown>;
  setStatus: (message: string) => void;
  /** `t` de i18next, ya ligada. */
  savedMessage: () => string;
};

export function createMissingMediaHandlers(deps: MissingMediaHandlerDeps) {
  const {
    runAction,
    applyPlaybackSnapshot,
    refreshSongView,
    refreshLibraryState,
    setStatus,
    savedMessage,
  } = deps;

  /** Cola común: repuntar, publicar, refrescar y avisar de que se guardó. */
  const relink = async (missingPath: string, replacementPath: string) => {
    const nextSnapshot = await resolveMissingFile(missingPath, replacementPath);
    applyPlaybackSnapshot(nextSnapshot);
    await Promise.all([refreshSongView(), refreshLibraryState()]);
    setStatus(savedMessage());
  };

  return {
    /**
     * Buscar el fichero a mano, con el selector de la plataforma.
     *
     * Android: el diálogo nativo devuelve un `content://`, no una ruta, y el
     * motor no sabe abrirlo — apuntar al fichero correcto "no hacía nada"
     * porque el clip quedaba repuntado a un URI ilegible. Se usa el selector
     * del WebView y se trae el FICHERO a la carpeta `audio/` de la sesión
     * (el mismo camino por etapas que un import de biblioteca), y luego se
     * repunta el clip a esa copia. El selector sólo se abre dentro de la
     * ventana del gesto del usuario, así que tiene que ir ANTES de cualquier
     * await.
     */
    async locateMissingFile(missingPath: string) {
      if (isMobileApp) {
        const files = await pickFilesViaWebView();
        const picked = files[0];
        if (!picked) {
          return;
        }

        await runAction(
          async () => {
            const stagedPayload = {
              fileName: picked.name,
              sourcePath: await stageFileForImport(picked, true),
            };
            const importedAssets = await importStagedAudioFiles([
              stagedPayload,
            ]);
            const relocated = importedAssets.assets[0];
            if (!relocated) {
              return;
            }
            await relink(missingPath, relocated.filePath);
          },
          { busy: true },
        );
        return;
      }

      await runAction(
        async () => {
          const selectedPath = await open({
            multiple: false,
            directory: false,
            title: "Locate missing audio file",
          });
          if (typeof selectedPath !== "string") {
            return;
          }
          await relink(missingPath, selectedPath);
        },
        { busy: true },
      );
    },

    /**
     * Enlazar con un candidato que la búsqueda automática ya encontró.
     *
     * Es una ruta del sistema de ficheros que propuso el backend mirando
     * carpetas conocidas, así que no hace falta selector ni, en móvil, pasar
     * por el import por etapas: mismo camino corto en todas las plataformas.
     */
    async relinkMissingFile(missingPath: string, replacementPath: string) {
      await runAction(
        async () => {
          await relink(missingPath, replacementPath);
        },
        { busy: true },
      );
    },
  };
}
