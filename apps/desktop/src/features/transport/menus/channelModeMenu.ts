import type { TrackChannelMode, TrackSummary } from "@libretracks/shared/models";
import { splitTrackChannels, updateTrackChannelMode } from "../desktopApi";
import type { ContextMenuAction } from "../types";
import type { TimelineMenuDeps } from "./timelineMenus";

/** Orden del submenú «Canales», como el Utility de Ableton. */
export const CHANNEL_MODES: readonly TrackChannelMode[] = ["stereo", "mono", "left", "right"];

const MODE_LABEL: Record<TrackChannelMode, { key: string; fallback: string }> = {
  stereo: { key: "transport.menu.channelMode.stereo", fallback: "Estéreo" },
  mono: { key: "transport.menu.channelMode.mono", fallback: "Mono (suma)" },
  left: { key: "transport.menu.channelMode.left", fallback: "Solo izquierdo" },
  right: { key: "transport.menu.channelMode.right", fallback: "Solo derecho" },
};

export function trackChannelMode(track: Pick<TrackSummary, "channelMode">): TrackChannelMode {
  return track.channelMode ?? "stereo";
}

/**
 * Entrada «Canales…» del menú de una pista de audio: abre un submenú con los
 * cuatro modos (✓ en el actual) y, debajo, las acciones extra que se le pasen
 * (p. ej. «Separar canales L/R»). Vive fuera de `timelineMenus.ts` para no
 * engordarlo (ver fileSizeBudget).
 */
export function createChannelModeMenu(
  getDeps: () => TimelineMenuDeps,
  openSubMenu: (title: string, actions: ContextMenuAction[]) => void,
) {
  function modeActions(track: TrackSummary): ContextMenuAction[] {
    const d = getDeps();
    const current = trackChannelMode(track);
    return CHANNEL_MODES.map((mode) => ({
      label: `${mode === current ? "✓ " : ""}${d.t(MODE_LABEL[mode].key, {
        defaultValue: MODE_LABEL[mode].fallback,
      })}`,
      onSelect: async () => {
        if (mode === current) {
          return;
        }
        await d.runAction(async () => {
          const nextSnapshot = await updateTrackChannelMode({
            trackId: track.id,
            channelMode: mode,
          });
          d.applyPlaybackSnapshot(nextSnapshot);
          await d.refreshSongView({ includeWaveforms: false });
        });
      },
    }));
  }

  /**
   * «Separar canales L/R»: deshabilitada si la pista no tiene audio estéreo
   * (ningún clip con canal derecho en su onda).
   */
  function splitChannelsAction(track: TrackSummary): ContextMenuAction {
    const d = getDeps();
    const hasStereo = track.hasStereoAudio !== false;
    return {
      label: hasStereo
        ? d.t("transport.menu.channelMode.split", { defaultValue: "Separar canales L/R" })
        : d.t("transport.menu.channelMode.splitNoStereo", {
            defaultValue: "Separar canales L/R (la pista no tiene audio estéreo)",
          }),
      section: d.t("transport.menu.channelMode.splitSection", { defaultValue: "Separar" }),
      disabled: !hasStereo,
      onSelect: async () => {
        if (!hasStereo) {
          return;
        }
        await d.runAction(async () => {
          const nextSnapshot = await splitTrackChannels({
            trackId: track.id,
            leftName: d.t("transport.menu.channelMode.leftName", {
              name: track.name,
              defaultValue: `${track.name} L`,
            }),
            rightName: d.t("transport.menu.channelMode.rightName", {
              name: track.name,
              defaultValue: `${track.name} R`,
            }),
          });
          d.applyPlaybackSnapshot(nextSnapshot);
          await d.refreshSongView({ includeWaveforms: false });
        });
      },
    };
  }

  function channelModeEntry(
    track: TrackSummary,
    extraActions: ContextMenuAction[] = [splitChannelsAction(track)],
  ): ContextMenuAction {
    const d = getDeps();
    const title = d.t("transport.menu.channelMode.title", { defaultValue: "Canales" });
    return {
      label: `${title}…`,
      onSelect: () => openSubMenu(title, [...modeActions(track), ...extraActions]),
    };
  }

  return { modeActions, splitChannelsAction, channelModeEntry };
}
