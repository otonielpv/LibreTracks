import { useCallback } from "react";

import { isAndroidApp } from "@libretracks/shared/desktopApi";

import type { ShortcutActionId } from "./actions";
import { formatBindingForDisplay, isMacPlatform } from "./keybinding";
import { resolveBindings, useKeybindingStore } from "./keybindingStore";

// Small hook that returns a formatter mapping an action id to its current,
// display-ready shortcut string (respecting the user's overrides). Used to show
// the key next to context-menu items, Reaper-style, so shortcuts are
// discoverable without opening Settings. Returns "" for unbound actions —
// and for everything on Android, where there is no physical keyboard to hint.
export function useShortcutHint(): (actionId: ShortcutActionId) => string {
  const overrides = useKeybindingStore((state) => state.overrides);
  return useCallback(
    (actionId: ShortcutActionId) => {
      if (isAndroidApp) {
        return "";
      }
      const binding = resolveBindings(overrides)[actionId] ?? null;
      return formatBindingForDisplay(binding, isMacPlatform());
    },
    [overrides],
  );
}
