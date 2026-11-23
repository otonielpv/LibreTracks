import { create } from "zustand";

import type { ShortcutActionId } from "./actions";

/**
 * The configurable actions (play/pause, stop…) reachable from components the
 * panel does not hand `runShortcutAction` to, such as the lyrics shown full
 * screen. `useTimelineKeyboardShortcuts` registers its runner here while it
 * is mounted; with nothing registered the call does nothing.
 */
type ShortcutRunnerState = {
  run: ((action: ShortcutActionId) => void) | null;
};

export const useShortcutRunnerStore = create<ShortcutRunnerState>(() => ({ run: null }));

export function runRegisteredShortcut(action: ShortcutActionId): void {
  useShortcutRunnerStore.getState().run?.(action);
}
