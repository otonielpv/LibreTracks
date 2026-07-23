import { useEffect } from "react";
import type {
  AppSettings,
  LibraryAssetSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";
import {
  getLibraryAssets,
  getLibraryFolders,
  getSettings,
  getSongView,
  getTransportSnapshot,
} from "../desktopApi";
import { useTransportStore, type MeterDictionary } from "../store";
import { useTimelineUIStore } from "../uiStore";

/**
 * Exposes a tiny, stable automation surface on `window.__ltE2E` — but ONLY when
 * the page is being driven by WebDriver (`navigator.webdriver === true`). In a
 * normal user session the hook is inert and nothing is attached to `window`.
 *
 * Why this exists: the E2E suite drives the real app, and the create/open-session
 * entry points open a NATIVE file dialog (`rfd`) that WebDriver cannot pilot.
 * Rather than reach for the dialog, tests call the same frontend handlers a user
 * click would, so the flow — invoke, await the `project:load-complete` event,
 * apply the snapshot to React state — runs identically to production. The
 * handlers already accept explicit paths (the Android landing uses them without
 * a dialog), so a test can create a session inside a temp folder it controls.
 *
 * Keep this surface minimal and stable: it is a test seam, not a public API.
 */
export interface E2ETestHooks {
  /** Create a session named `name` inside `parentDir` (a real filesystem path). */
  createSessionNamed: (name: string, parentDir?: string) => void;
  /** Open an existing session from its `.ltsession` file path. */
  openSessionFromPath: (songFile: string) => void;
  /** Import native audio paths through the production library-only pipeline. */
  importLibraryAudioFromPaths: (paths: string[]) => Promise<void>;
  /** Read-only backend observations used to assert completed E2E round trips. */
  getSongView: () => Promise<SongView | null>;
  getTransportSnapshot: () => Promise<TransportSnapshot>;
  getSettings: () => Promise<AppSettings>;
  getTimelineView: () => { cameraX: number; zoomLevel: number };
  getTrackMeters: () => MeterDictionary;
  getLibraryState: () => Promise<{
    assets: LibraryAssetSummary[];
    folders: string[];
  }>;
}

type E2EWindow = Window & { __ltE2E?: E2ETestHooks };

/**
 * @param createSessionNamed create a session named `name` inside `parentDir`.
 * @param openSessionFromPath open an existing session from its `.ltsession` path.
 * @param importLibraryAudioFromPaths import explicit paths without a native picker.
 */
export function useE2ETestHooks(
  createSessionNamed: E2ETestHooks["createSessionNamed"],
  openSessionFromPath: E2ETestHooks["openSessionFromPath"],
  importLibraryAudioFromPaths: E2ETestHooks["importLibraryAudioFromPaths"],
): void {
  useEffect(() => {
    // Gate on WebDriver so the seam never exists in a real user session.
    if (typeof navigator === "undefined" || navigator.webdriver !== true) {
      return;
    }

    const target = window as E2EWindow;
    target.__ltE2E = {
      createSessionNamed,
      openSessionFromPath,
      importLibraryAudioFromPaths,
      getSongView: () => getSongView({ includeWaveforms: false }),
      getTransportSnapshot,
      getSettings,
      getTimelineView: () => {
        const { cameraX, zoomLevel } = useTimelineUIStore.getState();
        return { cameraX, zoomLevel };
      },
      getTrackMeters: () => useTransportStore.getState().meters,
      getLibraryState: async () => {
        const [assets, folders] = await Promise.all([
          getLibraryAssets(),
          getLibraryFolders(),
        ]);
        return { assets, folders };
      },
    };

    return () => {
      delete target.__ltE2E;
    };
  }, [
    createSessionNamed,
    importLibraryAudioFromPaths,
    openSessionFromPath,
  ]);
}
