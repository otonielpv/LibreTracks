/**
 * The one definition of every lyrics action (plan lyrics-sync, D20). The DAW,
 * Setlist, Compact and mobile views only open the same components, which
 * call these. Built once with `useMemo`; volatile state is read through
 * getters so the factory never has to be rebuilt.
 */
import type {
  LeadTime,
  LyricsConfig,
  LyricsOverrideTarget,
  LyricsSoftware,
  RegionLyrics,
} from "@libretracks/shared/models";

import * as api from "./lyricsApi";
import type { LyricsConfigView, ProbeInfo, RegionReport } from "./lyricsApi";
import { withEnabled, withLead, withOverride, withPresentation } from "./lyricsEdits";
import { useLyricsStore } from "./lyricsStore";

export type LyricsApi = Pick<
  typeof api,
  | "getLyricsConfig"
  | "saveLyricsConfig"
  | "probeLyrics"
  | "setLyricsPaused"
  | "refreshLyrics"
  | "markLyricsTutorialDone"
  | "setRegionLyrics"
  | "testSendLyrics"
>;

export type LyricsHandlerDeps = {
  api?: LyricsApi;
  /** The song's current lyrics model, read when the action runs. */
  getRegionLyrics: (regionId: string) => RegionLyrics | null | undefined;
};

export type ProbeOutcome =
  | { ok: true; info: ProbeInfo }
  | { ok: false; error: api.LyricsError; port: number | null };

export function createLyricsHandlers({ api: injected, getRegionLyrics }: LyricsHandlerDeps) {
  const calls: LyricsApi = injected ?? api;
  const store = () => useLyricsStore.getState();
  const remember = (view: LyricsConfigView) => {
    store().setConfigView(view);
    return view;
  };
  const currentSoftware = (): LyricsSoftware | null =>
    store().configView?.config.software ?? null;
  const saveRegion = (regionId: string, lyrics: RegionLyrics | null) =>
    calls.setRegionLyrics(regionId, lyrics);

  return {
    loadConfig: async () => remember(await calls.getLyricsConfig()),

    /** The token travels apart from the config, never inside it. */
    saveConfig: async (config: LyricsConfig, token?: string) =>
      remember(await calls.saveLyricsConfig(config, token)),

    probe: async (
      software: LyricsSoftware,
      host: string,
      port: number | null,
      token?: string,
    ): Promise<ProbeOutcome> => {
      if (port === null) {
        return { ok: false, error: { kind: "unexpected", detail: "port" }, port };
      }
      try {
        return { ok: true, info: await calls.probeLyrics(software, host, port, token) };
      } catch (error) {
        return { ok: false, error: api.asLyricsError(error), port };
      }
    },

    setPaused: async (paused: boolean) => {
      await calls.setLyricsPaused(paused);
      const view = store().configView;
      if (view) store().setConfigView({ ...view, config: { ...view.config, paused } });
    },

    refresh: () => calls.refreshLyrics(),

    tutorialDone: async (software: LyricsSoftware) =>
      remember(await calls.markLyricsTutorialDone(software)),

    openLinker: () => store().openLinker(),
    openSongPanel: (regionId: string) => store().openSongPanel(regionId),

    /** Link a song to a presentation (one undo step). */
    linkRegion: async (regionId: string, presentation: { id: string; name: string }) => {
      const software = currentSoftware();
      if (!software) return;
      await saveRegion(regionId, withPresentation(getRegionLyrics(regionId), software, presentation));
    },

    /** "Accept all suggestions": the best one of each song, one save each. */
    acceptAllSuggestions: async (reports: RegionReport[]) => {
      const software = currentSoftware();
      if (!software) return;
      for (const report of reports) {
        const best = report.linkState.state === "suggested" ? report.suggestions[0] : null;
        const exactUnsaved =
          report.linkState.state === "linked" && !report.stored && report.link?.presentationId
            ? { id: report.link.presentationId, name: report.link.presentationName }
            : null;
        const choice = best ? { id: best.id, name: best.name } : exactUnsaved;
        if (choice) {
          await saveRegion(
            report.regionId,
            withPresentation(getRegionLyrics(report.regionId), software, choice),
          );
        }
      }
    },

    setOverride: async (
      regionId: string,
      markerId: string,
      target: LyricsOverrideTarget | null,
      onlyThisTime: boolean,
    ) => {
      const software = currentSoftware();
      if (!software) return;
      await saveRegion(
        regionId,
        withOverride(getRegionLyrics(regionId), software, markerId, target, onlyThisTime),
      );
    },

    setRegionEnabled: (regionId: string, enabled: boolean) =>
      saveRegion(regionId, withEnabled(getRegionLyrics(regionId), enabled)),

    setRegionLead: (regionId: string, lead: LeadTime | null) =>
      saveRegion(regionId, withLead(getRegionLyrics(regionId), lead)),

    testSend: (regionId: string, markerId: string, k = 0) =>
      calls.testSendLyrics(regionId, markerId, k),
  };
}

export type LyricsHandlers = ReturnType<typeof createLyricsHandlers>;
