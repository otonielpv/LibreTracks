import type {
  SongRegionSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import { promptDialog } from "../../../shared/dialog/dialogService";
import { updateSongRegionFades } from "../desktopApi";
import type { ContextMenuAction } from "../types";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type SongFadeMenuDeps = {
  t: Translate;
  runAction: (action: () => Promise<void>) => Promise<unknown>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
};

/**
 * Seconds typed by the user: accepts a decimal comma, "0" or an empty field
 * to remove the fade. `null` = not a valid duration (the prompt is dropped).
 */
export function parseFadeSeconds(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return 0;
  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

/** How a fade reads in the menu and the prompt: "2.5", "0". */
export function formatFadeSeconds(seconds: number | undefined): string {
  const value = seconds ?? 0;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

/**
 * Items of the song's "Fades ▸" submenu: one prompt each for the fade in and
 * the fade out, showing the current value. The song's other edits (key, warp
 * BPM) use the same prompt-from-the-menu pattern.
 */
export function songFadeMenuActions(
  region: SongRegionSummary,
  deps: SongFadeMenuDeps,
): ContextMenuAction[] {
  const fadeIn = region.master?.fadeInSeconds ?? 0;
  const fadeOut = region.master?.fadeOutSeconds ?? 0;

  const edit = async (which: "in" | "out") => {
    const { t } = deps;
    const current = which === "in" ? fadeIn : fadeOut;
    const input = await promptDialog(
      t(which === "in" ? "transport.prompt.songFadeIn" : "transport.prompt.songFadeOut"),
      formatFadeSeconds(current),
    );
    if (input === null) return;
    const seconds = parseFadeSeconds(input);
    if (seconds === null) return;
    await deps.runAction(async () => {
      const snapshot = await updateSongRegionFades(
        region.id,
        which === "in" ? seconds : fadeIn,
        which === "out" ? seconds : fadeOut,
      );
      deps.applyPlaybackSnapshot(snapshot);
      deps.setStatus(
        t("transport.status.songFadesUpdated", { name: region.name }),
      );
    });
  };

  return [
    {
      label: deps.t("transport.menu.songFadeIn", {
        seconds: formatFadeSeconds(fadeIn),
      }),
      onSelect: () => edit("in"),
    },
    {
      label: deps.t("transport.menu.songFadeOut", {
        seconds: formatFadeSeconds(fadeOut),
      }),
      onSelect: () => edit("out"),
    },
  ];
}
