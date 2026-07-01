// Central registry of keyboard-shortcut actions.
//
// This is the single source of truth for "what commands exist and what their
// default key is". The dispatcher (TimelineKeyboardShortcuts) maps an actionId
// to a handler; the shortcuts panel lists these definitions; the keybinding
// store merges user overrides on top of the `defaultBinding`s here.
//
// IMPORTANT: the default bindings below mirror exactly what the app shipped
// with before the registry existed, so introducing the registry is a pure
// refactor with no behavioural change. New shortcuts (split clip = "S",
// select-all, nudge) are added explicitly and called out.
//
// Out of scope on purpose: the marker/region jumps on 1–9 / Shift+1–9. Those
// are *dynamic* (they resolve against the current song's markers/regions), so
// they stay in the dispatcher rather than being editable rows. The panel shows
// them as fixed/informational.

export type ShortcutGroup =
  | "transport"
  | "edit"
  | "view"
  | "project"
  | "navigation";

export type ShortcutActionId =
  // transport
  | "transport.playPause"
  | "transport.stop"
  | "transport.gotoStart"
  // edit
  | "edit.splitClip"
  | "edit.splitSong"
  | "edit.copy"
  | "edit.paste"
  | "edit.duplicate"
  | "edit.delete"
  | "edit.rename"
  | "edit.undo"
  | "edit.redo"
  | "edit.redoAlt"
  | "edit.selectAll"
  | "edit.nudgeLeft"
  | "edit.nudgeRight"
  // project
  | "project.save"
  | "project.saveAs"
  // view
  | "view.toggleViewMode"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  // navigation
  | "nav.cancelOrClear";

export type ShortcutActionDef = {
  id: ShortcutActionId;
  group: ShortcutGroup;
  /** i18n key for the action's display name (under `shortcuts.action.*`). */
  labelKey: string;
  /** Canonical default binding, or null when the action ships unbound. */
  defaultBinding: string | null;
  /**
   * When false, the action is shown in the panel as informational/fixed and is
   * NOT dispatched by the timeline key handler — it's owned by another listener
   * (e.g. the app-level UI-zoom shortcuts in App.tsx, which also accept "+"/"_"
   * variants that don't fit the canonical binding form). Defaults to true.
   */
  editable?: boolean;
};

export const SHORTCUT_ACTIONS: ShortcutActionDef[] = [
  // --- Transport ---------------------------------------------------------
  {
    id: "transport.playPause",
    group: "transport",
    labelKey: "shortcuts.action.playPause",
    defaultBinding: "Space",
  },
  {
    id: "transport.stop",
    group: "transport",
    labelKey: "shortcuts.action.stop",
    defaultBinding: "Shift+Space",
  },
  {
    id: "transport.gotoStart",
    group: "transport",
    labelKey: "shortcuts.action.gotoStart",
    defaultBinding: "Home",
  },

  // --- Edit --------------------------------------------------------------
  {
    // NEW: split the selected clip(s) at the playhead. Mirrors splitSong's
    // Shift+S but for a single clip on plain S, as requested.
    id: "edit.splitClip",
    group: "edit",
    labelKey: "shortcuts.action.splitClip",
    defaultBinding: "S",
  },
  {
    id: "edit.splitSong",
    group: "edit",
    labelKey: "shortcuts.action.splitSong",
    defaultBinding: "Shift+S",
  },
  {
    id: "edit.copy",
    group: "edit",
    labelKey: "shortcuts.action.copy",
    defaultBinding: "Ctrl+C",
  },
  {
    id: "edit.paste",
    group: "edit",
    labelKey: "shortcuts.action.paste",
    defaultBinding: "Ctrl+V",
  },
  {
    id: "edit.duplicate",
    group: "edit",
    labelKey: "shortcuts.action.duplicate",
    defaultBinding: "Ctrl+D",
  },
  {
    id: "edit.delete",
    group: "edit",
    labelKey: "shortcuts.action.delete",
    defaultBinding: "Delete",
  },
  {
    // Rename the selected song / track / marker (whichever is selected).
    id: "edit.rename",
    group: "edit",
    labelKey: "shortcuts.action.rename",
    defaultBinding: "F2",
  },
  {
    id: "edit.undo",
    group: "edit",
    labelKey: "shortcuts.action.undo",
    defaultBinding: "Ctrl+Z",
  },
  {
    id: "edit.redo",
    group: "edit",
    labelKey: "shortcuts.action.redo",
    defaultBinding: "Ctrl+Shift+Z",
  },
  {
    id: "edit.redoAlt",
    group: "edit",
    labelKey: "shortcuts.action.redoAlt",
    defaultBinding: "Ctrl+Y",
  },
  {
    // NEW: select every clip in the project.
    id: "edit.selectAll",
    group: "edit",
    labelKey: "shortcuts.action.selectAll",
    defaultBinding: "Ctrl+A",
  },
  {
    // NEW: nudge selected clip(s) left by one snap subdivision.
    id: "edit.nudgeLeft",
    group: "edit",
    labelKey: "shortcuts.action.nudgeLeft",
    defaultBinding: "ArrowLeft",
  },
  {
    // NEW: nudge selected clip(s) right by one snap subdivision.
    id: "edit.nudgeRight",
    group: "edit",
    labelKey: "shortcuts.action.nudgeRight",
    defaultBinding: "ArrowRight",
  },

  // --- Project -----------------------------------------------------------
  {
    id: "project.save",
    group: "project",
    labelKey: "shortcuts.action.save",
    defaultBinding: "Ctrl+S",
  },
  {
    id: "project.saveAs",
    group: "project",
    labelKey: "shortcuts.action.saveAs",
    defaultBinding: "Ctrl+Shift+S",
  },

  // --- View --------------------------------------------------------------
  {
    id: "view.toggleViewMode",
    group: "view",
    labelKey: "shortcuts.action.toggleViewMode",
    defaultBinding: "Tab",
  },
  {
    // Owned by the app-level handler in App.tsx (accepts Ctrl + "="/"+"),
    // shown here for discoverability but not editable.
    id: "view.zoomIn",
    group: "view",
    labelKey: "shortcuts.action.zoomIn",
    defaultBinding: "Ctrl+=",
    editable: false,
  },
  {
    id: "view.zoomOut",
    group: "view",
    labelKey: "shortcuts.action.zoomOut",
    defaultBinding: "Ctrl+-",
    editable: false,
  },
  {
    id: "view.zoomReset",
    group: "view",
    labelKey: "shortcuts.action.zoomReset",
    defaultBinding: "Ctrl+0",
    editable: false,
  },

  // --- Navigation --------------------------------------------------------
  {
    id: "nav.cancelOrClear",
    group: "navigation",
    labelKey: "shortcuts.action.cancelOrClear",
    defaultBinding: "Escape",
  },
];

export const SHORTCUT_GROUP_ORDER: ShortcutGroup[] = [
  "transport",
  "edit",
  "project",
  "view",
  "navigation",
];

/** i18n key for a group heading (under `shortcuts.group.*`). */
export function shortcutGroupLabelKey(group: ShortcutGroup): string {
  return `shortcuts.group.${group}`;
}

const ACTION_BY_ID = new Map<ShortcutActionId, ShortcutActionDef>(
  SHORTCUT_ACTIONS.map((action) => [action.id, action]),
);

export function getShortcutAction(
  id: ShortcutActionId,
): ShortcutActionDef | undefined {
  return ACTION_BY_ID.get(id);
}
