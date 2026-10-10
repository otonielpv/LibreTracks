import { describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS, type SongView } from "@libretracks/shared/models";
import type { NetworkCommand, NetworkRole } from "@libretracks/shared/networkApi";

import type { LiveViewSettings } from "../transport/live/LivePerformanceView";
import { createGuestCommandHandlers } from "./guestCommandHandlers";

function setup(
  overrides: {
    role?: NetworkRole | null;
    settings?: Partial<LiveViewSettings>;
    playbackState?: string;
    pending?: string | null;
    sendError?: string;
    /** Errors for successive sends, then success. */
    sendErrors?: string[];
    overwrite?: boolean;
  } = {},
) {
  const sent: Array<{ command: NetworkCommand; revision?: number }> = [];
  const onError = vi.fn();
  const handlers = createGuestCommandHandlers({
    send: vi.fn(async (command: NetworkCommand, revision?: number) => {
      if (overrides.sendError) throw overrides.sendError;
      const queued = overrides.sendErrors?.shift();
      if (queued) {
        sent.push({ command, revision });
        throw queued;
      }
      sent.push({ command, revision });
    }),
    getRole: () => (overrides.role === undefined ? "controller" : overrides.role),
    getSettings: () => ({ ...DEFAULT_APP_SETTINGS, ...overrides.settings }) as LiveViewSettings,
    getSong: () => ({ projectRevision: 7 }) as SongView,
    getPlaybackState: () => overrides.playbackState ?? "playing",
    getPendingMarkerId: () => overrides.pending ?? null,
    onError,
    confirmOverwrite: vi.fn(async () => overrides.overwrite ?? false),
    errorText: (code: string) => `text:${code}`,
  });
  return { handlers, sent, onError };
}

const marker = { id: "chorus", name: "Coro", startSeconds: 30, kind: "chorus" } as never;
const region = { id: "song-2", name: "Segunda", startSeconds: 40, endSeconds: 80 } as never;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createGuestCommandHandlers", () => {
  it("jumps to a marker with the host's marker-jump mode", async () => {
    const { handlers, sent } = setup({
      settings: { globalJumpMode: "after_bars", globalJumpBars: 2 },
    });
    handlers.onMarkerAction(marker);
    await flush();
    expect(sent).toEqual([
      { command: { cmd: "jumpToMarker", markerId: "chorus", trigger: "after_bars", bars: 2 } },
    ]);
  });

  it("touching the queued marker again cancels the jump", async () => {
    const { handlers, sent } = setup({ pending: "chorus" });
    handlers.onMarkerAction(marker);
    await flush();
    expect(sent.map((entry) => entry.command)).toEqual([{ cmd: "cancelJump" }]);
  });

  it("a song while playing is a scheduled song jump", async () => {
    const { handlers, sent } = setup({
      settings: { songJumpTrigger: "region_end", songTransitionMode: "fade_out" },
    });
    handlers.onSongAction(region);
    await flush();
    expect(sent[0].command).toMatchObject({
      cmd: "jumpToSong",
      regionId: "song-2",
      trigger: "region_end",
      transition: "fade_out",
    });
  });

  it("a song while stopped goes there and plays", async () => {
    const { handlers, sent } = setup({ playbackState: "stopped" });
    handlers.onSongAction(region);
    await flush();
    await flush();
    expect(sent.map((entry) => entry.command)).toEqual([
      { cmd: "seek", positionSeconds: 40 },
      { cmd: "play" },
    ]);
  });

  it("vamp uses the host's vamp mode", async () => {
    const { handlers, sent } = setup({ settings: { vampMode: "bars", vampBars: 8 } });
    handlers.onToggleVamp();
    await flush();
    expect(sent[0].command).toEqual({ cmd: "toggleVamp", mode: "bars", bars: 8 });
  });

  it("jump settings change on the host", async () => {
    const { handlers, sent } = setup();
    handlers.onVampModeChange("section");
    handlers.onSongJumpBarsChange(16);
    await flush();
    expect(sent.map((entry) => entry.command)).toEqual([
      { cmd: "setJumpSettings", vampMode: "section" },
      { cmd: "setJumpSettings", songJumpBars: 16 },
    ]);
  });

  it("a viewer sends nothing", async () => {
    const { handlers, sent } = setup({ role: "viewer" });
    handlers.play();
    handlers.onMarkerAction(marker);
    handlers.onSongAction(region);
    handlers.onToggleVamp();
    await flush();
    expect(sent).toEqual([]);
  });

  it("chart edits need the editor role and carry the song's revision", async () => {
    const controller = setup();
    await expect(controller.handlers.onChartChange("song-2", null)).rejects.toThrow(
      "text:forbidden",
    );
    expect(controller.sent).toEqual([]);

    const editor = setup({ role: "editor" });
    await editor.handlers.onChartChange("song-2", { text: "[C]x", links: [] } as never);
    expect(editor.sent).toEqual([
      { command: { cmd: "setSongChart", regionId: "song-2", chart: { text: "[C]x", links: [] } }, revision: 7 },
    ]);
  });

  it("a refusal from the host is reported", async () => {
    const { handlers, onError } = setup({ sendError: "forbidden" });
    handlers.stop();
    await flush();
    expect(onError).toHaveBeenCalledWith("forbidden");
  });
});

describe("editing a song the host changed meanwhile", () => {
  const chart = { text: "[C]x", links: [] } as never;

  it("keeping the edit open throws the explained error and sends nothing more", async () => {
    const { handlers, sent } = setup({ role: "editor", sendErrors: ["stale"], overwrite: false });
    await expect(handlers.onChartChange("s", chart)).rejects.toThrow("text:stale");
    expect(sent).toHaveLength(1);
  });

  it("overwriting resends against the host's current revision", async () => {
    const { handlers, sent } = setup({ role: "editor", sendErrors: ["stale"], overwrite: true });
    await handlers.onChartChange("s", chart);
    expect(sent).toHaveLength(2);
    expect(sent[1].revision).toBe(7);
  });

  it("other refusals do not ask to overwrite", async () => {
    const { handlers, sent } = setup({ role: "editor", sendErrors: ["invalid"], overwrite: true });
    await expect(handlers.onChartChange("s", chart)).rejects.toThrow("text:invalid");
    expect(sent).toHaveLength(1);
  });
});

describe("mix and key (editor)", () => {
  it("track, song master and metronome go to the host", async () => {
    const { handlers, sent } = setup({ role: "editor" });
    handlers.setTrackMix("drums", { muted: true }, false);
    handlers.setTrackMix("bass", { volume: 0.5 }, true);
    handlers.setSongMasterGain("s", 0.8, false);
    handlers.setMetronome({ enabled: false });
    await flush();
    expect(sent.map((entry) => entry.command)).toEqual([
      { cmd: "setTrackMix", trackId: "drums", muted: true, live: false },
      { cmd: "setTrackMix", trackId: "bass", volume: 0.5, live: true },
      { cmd: "setSongMasterGain", regionId: "s", masterGain: 0.8, live: false },
      { cmd: "setMetronome", enabled: false },
    ]);
  });

  it("song key changes carry the revision", async () => {
    const { handlers, sent } = setup({ role: "editor" });
    handlers.setSongTranspose("s", 2);
    await flush();
    expect(sent).toEqual([
      { command: { cmd: "setSongTranspose", regionId: "s", semitones: 2 }, revision: 7 },
    ]);
  });

  it("a controller cannot touch the mix", async () => {
    const { handlers, sent } = setup({ role: "controller" });
    handlers.setTrackMix("drums", { muted: true }, false);
    handlers.setMetronome({ enabled: true });
    await flush();
    expect(sent).toEqual([]);
  });
});
