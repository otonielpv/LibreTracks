import { create } from "zustand";

/** The Planning Center plan import, open or not. Mounted by `PlanImportHost`
 * in `LyricsRoot`; opened from the Planning Center account. */
type PlanImportState = {
  open: boolean;
  show: () => void;
  close: () => void;
};

export const usePlanImportStore = create<PlanImportState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
