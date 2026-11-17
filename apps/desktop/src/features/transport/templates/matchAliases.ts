import { promptDialog } from "../../../shared/dialog/dialogService";
import type { ContextMenuAction } from "../types";
import {
  updateTrackMatchAliases,
  type TrackSummary,
  type TransportSnapshot,
} from "../desktopApi";

/** "EG, Guitarra , ,gtr" → ["EG", "Guitarra", "gtr"]. The backend cleans the
 * list again (repeats, length); this only splits what the user typed. */
export function parseMatchAliases(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

export function formatMatchAliases(aliases: readonly string[] | undefined): string {
  return (aliases ?? []).join(", ");
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

type MatchAliasesDeps = {
  t: Translate;
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSongView: () => Promise<unknown>;
  setStatus: (message: string) => void;
};

/**
 * «Reglas de coincidencia…» in a track's or folder's context menu: edit the
 * words that send a dropped stem to it. MIDI and video tracks never receive
 * audio, so the caller only offers it on audio tracks and folders.
 */
export function matchAliasesAction(
  track: TrackSummary,
  deps: MatchAliasesDeps,
): ContextMenuAction {
  const { t } = deps;
  return {
    label: t("songTemplates.matchAliases"),
    onSelect: async () => {
      const answer = await promptDialog(
        t("songTemplates.matchAliasesPrompt", { name: track.name }),
        formatMatchAliases(track.matchAliases),
      );
      if (answer === null) {
        return;
      }
      await deps.runAction(async () => {
        const snapshot = await updateTrackMatchAliases({
          trackId: track.id,
          aliases: parseMatchAliases(answer),
        });
        deps.applyPlaybackSnapshot(snapshot);
        // The aliases live on the track summary the next prompt reads from.
        await deps.refreshSongView();
        deps.setStatus(t("songTemplates.matchAliasesUpdated", { name: track.name }));
      });
    },
  };
}
