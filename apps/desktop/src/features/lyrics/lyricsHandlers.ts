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
  LyricsSlideTiming,
  LyricsSoftware,
  LyricsStartTarget,
  RegionLyrics,
} from "@libretracks/shared/models";

import * as api from "./lyricsApi";
import type { LyricsConfigView, ProbeInfo, RegionReport } from "./lyricsApi";
import {
  withEnabled,
  withLead,
  withMarkerLead,
  withOverride,
  withPresentation,
  withSectionRecording,
  withSlides,
  withStart,
  withTiming,
} from "./lyricsEdits";
import { useLyricsStore } from "./lyricsStore";

export type LyricsApi = Pick<
  typeof api,
  | "getLyricsConfig"
  | "saveLyricsConfig"
  | "probeLyrics"
  | "scanLyrics"
  | "setLyricsPaused"
  | "refreshLyrics"
  | "markLyricsTutorialDone"
  | "setRegionLyrics"
  | "testSendLyrics"
  | "getRegionReport"
  | "getSetlistReport"
  | "listPresentations"
  | "sectionStepsFromTaps"
  | "getSlideThumbnails"
  | "getTapPosition"
  | "playTransport"
  | "pauseTransport"
  | "seekTransport"
  | "setLyricsRecording"
>;

export type LyricsHandlerDeps = {
  api?: LyricsApi;
  /** Folds the snapshot a saved edit returns into the transport. */
  onSnapshot?: (snapshot: unknown) => void;
  /** The song's current lyrics model, read when the action runs. */
  getRegionLyrics: (regionId: string) => RegionLyrics | null | undefined;
  /** A save went through: keep the local song in step at once, so the next
   * edit builds on this one instead of on a stale copy. */
  onRegionSaved?: (regionId: string, lyrics: RegionLyrics | null) => void;
};

export type ProbeOutcome =
  | { ok: true; info: ProbeInfo }
  | { ok: false; error: api.LyricsError; port: number | null };

export function createLyricsHandlers({
  api: injected,
  getRegionLyrics,
  onSnapshot,
  onRegionSaved,
}: LyricsHandlerDeps) {
  const calls: LyricsApi = injected ?? api;
  const store = () => useLyricsStore.getState();
  const remember = (view: LyricsConfigView) => {
    store().setConfigView(view);
    return view;
  };
  const currentSoftware = (): LyricsSoftware | null =>
    store().configView?.config.software ?? null;
  const saveRegion = async (regionId: string, lyrics: RegionLyrics | null) => {
    const snapshot = await calls.setRegionLyrics(regionId, lyrics);
    onRegionSaved?.(regionId, lyrics);
    onSnapshot?.(snapshot);
    // Open panels (the linker's counts) read the session again.
    store().bumpLinks();
    return snapshot;
  };

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

    /** «Buscar en la red»: never throws; nothing found is an empty list. */
    scan: async (software: LyricsSoftware, port: number | null): Promise<api.FoundProgram[]> => {
      try {
        return await calls.scanLyrics(software, port);
      } catch {
        return [];
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

    /** Slides chosen in the section editor (exact marker ids); an empty
     * list gives the marker back to its group. One undo step. */
    setSlides: async (regionId: string, chosen: Array<{ markerId: string; indexes: number[] }>) => {
      const software = currentSoftware();
      if (!software) return;
      await saveRegion(regionId, withSlides(getRegionLyrics(regionId), software, chosen));
    },

    /** What shows when the song starts; `null` = automatic. */
    setStart: async (regionId: string, start: LyricsStartTarget | null) => {
      const software = currentSoftware();
      if (!software) return;
      await saveRegion(regionId, withStart(getRegionLyrics(regionId), software, start));
    },

    /** A marker's own lead; `null` gives it back the song's. */
    setMarkerLead: (regionId: string, markerId: string, lead: LeadTime | null) =>
      saveRegion(regionId, withMarkerLead(getRegionLyrics(regionId), markerId, lead)),

    setTiming: (regionId: string, markerId: string, timing: LyricsSlideTiming) =>
      saveRegion(regionId, withTiming(getRegionLyrics(regionId), markerId, timing)),

    tapPosition: () => calls.getTapPosition(),

    slideThumbnails: (presentationId: string, indexes: number[], cachedOnly = false) =>
      calls.getSlideThumbnails(presentationId, indexes, cachedOnly),

    setRecording: (regionId: string | null) => calls.setLyricsRecording(regionId),

    /** Transport for the recorder (no keyboard on a phone). Returns whether
     * it is playing now. */
    play: async () => {
      const snapshot = await calls.playTransport();
      onSnapshot?.(snapshot);
      return snapshot.playbackState === "playing";
    },
    pause: async () => {
      const snapshot = await calls.pauseTransport();
      onSnapshot?.(snapshot);
      return snapshot.playbackState === "playing";
    },
    seekTo: async (seconds: number) => {
      const snapshot = await calls.seekTransport(seconds);
      onSnapshot?.(snapshot);
      return snapshot.playbackState === "playing";
    },

    /** Save one section's recording: one commit, one undo step. */
    saveSectionRecording: async (regionId: string, markerId: string, taps: number[]) => {
      const steps = await calls.sectionStepsFromTaps(regionId, markerId, taps);
      return saveRegion(regionId, withSectionRecording(getRegionLyrics(regionId), markerId, steps));
    },

    regionReport: (regionId: string) => calls.getRegionReport(regionId),
    setlistReport: () => calls.getSetlistReport(),
    listPresentations: () => calls.listPresentations(),
  };
}

export type LyricsHandlers = ReturnType<typeof createLyricsHandlers>;
