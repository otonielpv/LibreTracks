import {
  roleAllows,
  type NetworkCommand,
  type NetworkRole,
} from "@libretracks/shared/networkApi";
import type {
  SectionMarkerSummary,
  SongChart,
  SongRegionSummary,
  SongView,
} from "@libretracks/shared/models";

import type { LiveViewSettings } from "../transport/live/LivePerformanceView";

/**
 * What a network-session guest's live view does when touched: every action
 * becomes a command to the host. Built once (`useMemo`); volatile state is
 * read through getters so the factory never needs rebuilding.
 *
 * No optimism: nothing on the guest screen changes until the host's next
 * snapshot says so, so the guest never shows something the host did not do.
 * The same decisions as the host's own live view, made with the host's jump
 * settings (`liveSettings`), so a jump from a tablet behaves like one from
 * the host's screen.
 */
export type GuestCommandDeps = {
  send: (command: NetworkCommand, baseRevision?: number) => Promise<void>;
  getRole: () => NetworkRole | null;
  getSettings: () => LiveViewSettings;
  getSong: () => SongView | null;
  getPlaybackState: () => string | null;
  getPendingMarkerId: () => string | null;
  onError: (code: string) => void;
};

function errorCode(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createGuestCommandHandlers(deps: GuestCommandDeps) {
  const run = async (command: NetworkCommand, baseRevision?: number) => {
    if (!roleAllows(deps.getRole(), command.cmd)) return;
    try {
      await deps.send(command, baseRevision);
    } catch (error) {
      deps.onError(errorCode(error));
    }
  };

  const setJumpSettings = (settings: Omit<Extract<NetworkCommand, { cmd: "setJumpSettings" }>, "cmd">) =>
    void run({ cmd: "setJumpSettings", ...settings });

  return {
    play: () => void run({ cmd: "play" }),
    pause: () => void run({ cmd: "pause" }),
    stop: () => void run({ cmd: "stop" }),
    fadeOutStop: () => void run({ cmd: "fadeOutStop" }),

    /** Same as the host's live view: touching the queued marker again
     * cancels its jump; otherwise jump with the host's marker-jump mode. */
    onMarkerAction: (marker: SectionMarkerSummary) => {
      if (deps.getPendingMarkerId() === marker.id) {
        void run({ cmd: "cancelJump" });
        return;
      }
      const settings = deps.getSettings();
      void run({
        cmd: "jumpToMarker",
        markerId: marker.id,
        trigger: settings.globalJumpMode,
        bars: Math.max(1, Math.floor(settings.globalJumpBars)),
      });
    },

    /** Playing: schedule the song jump with the host's song-jump settings.
     * Stopped: go to the song and play, which is what «play this song»
     * means when nothing sounds yet. */
    onSongAction: (region: SongRegionSummary) => {
      const settings = deps.getSettings();
      if (deps.getPlaybackState() === "playing") {
        void run({
          cmd: "jumpToSong",
          regionId: region.id,
          trigger: settings.songJumpTrigger,
          bars: Math.max(1, Math.floor(settings.songJumpBars)),
          transition: settings.songTransitionMode,
        });
        return;
      }
      void (async () => {
        await run({ cmd: "seek", positionSeconds: region.startSeconds });
        await run({ cmd: "play" });
      })();
    },

    onToggleVamp: () => {
      const settings = deps.getSettings();
      void run({
        cmd: "toggleVamp",
        mode: settings.vampMode,
        bars: settings.vampMode === "bars" ? settings.vampBars : undefined,
      });
    },

    onCancelPendingJump: () => void run({ cmd: "cancelJump" }),

    onReorderSong: (regionId: string, targetIndex: number) =>
      void run({ cmd: "reorderSong", regionId, targetIndex }),

    /** Editor only; the base revision lets the host refuse a stale edit. */
    onChartChange: async (regionId: string, chart: SongChart | null) => {
      if (!roleAllows(deps.getRole(), "setSongChart")) return;
      const revision = deps.getSong()?.projectRevision;
      await deps.send({ cmd: "setSongChart", regionId, chart }, revision);
    },

    onGlobalJumpModeChange: (globalJumpMode: string) => setJumpSettings({ globalJumpMode }),
    onGlobalJumpBarsChange: (globalJumpBars: number) => setJumpSettings({ globalJumpBars }),
    onSongJumpTriggerChange: (songJumpTrigger: string) => setJumpSettings({ songJumpTrigger }),
    onSongJumpBarsChange: (songJumpBars: number) => setJumpSettings({ songJumpBars }),
    onSongTransitionModeChange: (songTransitionMode: string) =>
      setJumpSettings({ songTransitionMode }),
    onVampModeChange: (vampMode: string) => setJumpSettings({ vampMode }),
    onVampBarsChange: (vampBars: number) => setJumpSettings({ vampBars }),
  };
}

export type GuestCommandHandlers = ReturnType<typeof createGuestCommandHandlers>;
