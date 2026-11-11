import { create } from "zustand";

/**
 * Bumped whenever the templates folder changes from inside the app (a template
 * imported or saved), so every list of templates on screen re-scans.
 *
 * In a module of its own, with nothing else in it, because the template lists
 * are used all over (Setlist, Settings, the landing) and must not drag the
 * cloud flows and their i18n into every test that renders one.
 */
export const useTemplateCatalogStore = create<{ version: number; bump: () => void }>(
  (set) => ({
    version: 0,
    bump: () => set((state) => ({ version: state.version + 1 })),
  }),
);
