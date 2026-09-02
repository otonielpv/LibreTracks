import {
  getEffectiveBpmAt,
  regionEffectiveKey,
  type SongView,
} from "@libretracks/shared/models";

import { exportAskingWhere, finishExportWithChoice } from "./cloudFlows";
import { buildPackageFileName } from "./packageNaming";

/**
 * Ready-made `onConfirm` callbacks for the two export modals.
 *
 * They exist so `TransportPanelContent` names the intent in one line instead of
 * spelling out a nested closure per modal. That file is under a hard line
 * budget and the rule is to extract rather than raise it — and the wiring reads
 * better here anyway, next to the flows it drives.
 */

/**
 * Song export: the destination is asked *after* the mode.
 *
 * A `.ltpkg` is a single song, so the mode barely changes what an upload costs,
 * and the trigger that opens the mode chooser lives in a cloud-agnostic
 * handlers factory that should not learn about the cloud to reorder a question.
 */
export function confirmSongExport(
  song: SongView | null,
  runExport: (
    regionId: string,
    includeAudio: boolean,
    writePath?: string,
  ) => Promise<void> | void,
) {
  return (regionId: string, includeAudio: boolean) => {
    const region = song?.regions.find((candidate) => candidate.id === regionId);
    // The values a musician would recognise, not the raw stored ones: the key
    // is the region key AFTER its transposition, and the tempo is the one in
    // force where the song actually starts, which a tempo marker may have
    // changed from the project default.
    const fileName = buildPackageFileName(region?.name ?? "cancion", ".ltpkg", {
      bpm: region ? getEffectiveBpmAt(song, region.startSeconds) : null,
      key: regionEffectiveKey(region),
      timeSignature: song?.timeSignature,
    });
    void exportAskingWhere("song", fileName, (path) =>
      runExport(regionId, includeAudio, path),
    );
  };
}

/**
 * Session export: the destination was already asked *before* the mode chooser
 * opened, because for a whole set the mode is the difference between a file and
 * a very long upload — an Optimized set is several times larger than the
 * original. This only spends that answer.
 */
export function confirmSessionExport<TMode>(
  session: Pick<SongView, "title" | "bpm" | "timeSignature"> | null,
  runExport: (mode: TMode, writePath?: string) => Promise<void> | void,
  closeModal: () => void,
) {
  return (mode: TMode) => {
    closeModal();
    // No key: a set spans many songs in many keys, so declaring one would be a
    // lie. Tempo and meter are the project defaults, which is what someone
    // scanning a list of sets is actually after.
    const fileName = buildPackageFileName(session?.title ?? "sesion", ".ltset", {
      bpm: session?.bpm,
      timeSignature: session?.timeSignature,
    });
    void finishExportWithChoice(fileName, (path) => runExport(mode, path));
  };
}
