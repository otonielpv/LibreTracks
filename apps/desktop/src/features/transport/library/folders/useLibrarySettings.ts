import { useCallback, useEffect, useState } from "react";

import {
  forgetLibraryPlace,
  getSettings,
  isTauriApp,
  listenToSettingsUpdated,
  saveSettings,
  type AppSettings,
} from "../../desktopApi";
import { addPlace, removePlace } from "./libraryPlaces";

export type LibrarySettings = {
  /** Which library the sidebar shows. */
  mode: AppSettings["libraryMode"];
  places: string[];
  addPlace: (path: string) => Promise<void>;
  removePlace: (path: string) => Promise<void>;
  setMode: (mode: AppSettings["libraryMode"]) => Promise<void>;
};

/**
 * The folder library's settings, read and written by the library itself so
 * the transport panel does not have to thread them through. Saving emits
 * `settings:updated`, which the panel already listens to, so its copy of the
 * settings stays in step.
 */
export function useLibrarySettings(): LibrarySettings {
  // Classic until the settings arrive (and outside the app, in the browser
  // demo and tests): never flash a library the user did not choose.
  const [mode, setMode] = useState<AppSettings["libraryMode"]>("classic");
  const [places, setPlaces] = useState<string[]>([]);

  useEffect(() => {
    if (!isTauriApp) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const apply = (settings: AppSettings) => {
      setMode(settings.libraryMode ?? "folders");
      setPlaces(settings.libraryPlaces ?? []);
    };
    void getSettings()
      .then((settings) => active && apply(settings))
      .catch(() => undefined);
    void listenToSettingsUpdated((settings) => active && apply(settings)).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const savePlaces = useCallback(async (update: (current: string[]) => string[]) => {
    // Read the saved settings right before writing, so a change made elsewhere
    // in the meantime (another setting, another window) is not overwritten.
    const settings = await getSettings();
    const current = settings.libraryPlaces ?? [];
    const next = update(current);
    if (next === current) return;
    setPlaces(next);
    await saveSettings({ ...settings, libraryPlaces: next });
  }, []);

  const saveMode = useCallback(async (next: AppSettings["libraryMode"]) => {
    const settings = await getSettings();
    setMode(next);
    if (settings.libraryMode === next) return;
    await saveSettings({ ...settings, libraryMode: next });
  }, []);

  return {
    mode,
    setMode: saveMode,
    places,
    addPlace: (path) => savePlaces((current) => addPlace(current, path)),
    removePlace: async (path) => {
      await savePlaces((current) => removePlace(current, path));
      // Android: give the tree's persistable permission back.
      await forgetLibraryPlace(path).catch(() => undefined);
    },
  };
}
