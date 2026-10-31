import { create } from "zustand";

/**
 * Whether the mix scenes editor is open. A store, like "Nivelar canciones",
 * so File, the Setlist and the automation lane open it with one call:
 * scenes no longer need an automation track to exist.
 */
type MixSceneEditorStore = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

export const useMixSceneEditorStore = create<MixSceneEditorStore>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export const setMixSceneEditorOpen = (open: boolean) =>
  useMixSceneEditorStore.getState().setOpen(open);

export const openMixSceneEditor = () => setMixSceneEditorOpen(true);
