import { create } from "zustand";

import {
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
} from "./actions";

// Persistent, user-customisable map of action → key binding.
//
// We persist ONLY the overrides the user has explicitly set, not the full
// resolved map. That way, if a future app version changes a default binding
// (or adds a new action), users who never touched that action inherit the new
// default automatically. An override value of `null` means "the user removed
// the binding" (the action has no shortcut), which is distinct from "no
// override" (inherit the default).

const STORAGE_KEY = "lt.keybindings.v1";

export type BindingOverrides = Partial<Record<ShortcutActionId, string | null>>;

const VALID_ACTION_IDS = new Set<string>(
  SHORTCUT_ACTIONS.map((action) => action.id),
);

const DEFAULTS: Record<ShortcutActionId, string | null> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultBinding]),
) as Record<ShortcutActionId, string | null>;

function readStoredOverrides(): BindingOverrides {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    // Keep only known action ids and string|null values — defends against a
    // stale/corrupt blob from an older build.
    const cleaned: BindingOverrides = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        VALID_ACTION_IDS.has(key) &&
        (value === null || typeof value === "string")
      ) {
        cleaned[key as ShortcutActionId] = value;
      }
    }
    return cleaned;
  } catch {
    return {};
  }
}

function persistOverrides(overrides: BindingOverrides): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Private mode / storage disabled — keep the in-memory value anyway.
  }
}

/** Merge defaults with overrides into the effective action → binding map. */
export function resolveBindings(
  overrides: BindingOverrides,
): Record<ShortcutActionId, string | null> {
  return { ...DEFAULTS, ...overrides };
}

/**
 * Build the reverse index (binding → actionId) used by the dispatcher and by
 * conflict detection. Unbound actions (null) are skipped. If two actions
 * somehow share a binding, last-in wins for the dispatcher; the panel surfaces
 * the clash before it gets persisted, so this is just a defensive tie-break.
 */
export function buildBindingIndex(
  resolved: Record<ShortcutActionId, string | null>,
): Map<string, ShortcutActionId> {
  const index = new Map<string, ShortcutActionId>();
  for (const [id, binding] of Object.entries(resolved)) {
    if (binding) {
      index.set(binding, id as ShortcutActionId);
    }
  }
  return index;
}

type KeybindingState = {
  overrides: BindingOverrides;
  /** Set (or override) the binding for an action. */
  setBinding: (actionId: ShortcutActionId, binding: string) => void;
  /** Remove the binding entirely (action becomes unbound). */
  clearBinding: (actionId: ShortcutActionId) => void;
  /** Drop the override so the action falls back to its shipped default. */
  resetBinding: (actionId: ShortcutActionId) => void;
  /** Wipe every override; the whole map returns to defaults. */
  resetAll: () => void;
};

export const useKeybindingStore = create<KeybindingState>((set) => ({
  overrides: readStoredOverrides(),
  setBinding: (actionId, binding) =>
    set((state) => {
      const overrides = { ...state.overrides, [actionId]: binding };
      persistOverrides(overrides);
      return { overrides };
    }),
  clearBinding: (actionId) =>
    set((state) => {
      const overrides = { ...state.overrides, [actionId]: null };
      persistOverrides(overrides);
      return { overrides };
    }),
  resetBinding: (actionId) =>
    set((state) => {
      const overrides = { ...state.overrides };
      delete overrides[actionId];
      persistOverrides(overrides);
      return { overrides };
    }),
  resetAll: () =>
    set(() => {
      persistOverrides({});
      return { overrides: {} };
    }),
}));

/**
 * Find the action currently bound to `binding`, excluding `exceptId`. Used by
 * the panel to warn about a conflict before assigning. Returns null when the
 * binding is free.
 */
export function findBindingConflict(
  overrides: BindingOverrides,
  binding: string,
  exceptId: ShortcutActionId,
): ShortcutActionId | null {
  const resolved = resolveBindings(overrides);
  for (const [id, value] of Object.entries(resolved)) {
    if (id !== exceptId && value === binding) {
      return id as ShortcutActionId;
    }
  }
  return null;
}

// Re-export so callers don't need to reach into the store internals.
export { STORAGE_KEY as KEYBINDINGS_STORAGE_KEY };
