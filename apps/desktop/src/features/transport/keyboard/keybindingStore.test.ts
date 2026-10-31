import { beforeEach, describe, expect, it } from "vitest";

import { SHORTCUT_ACTIONS } from "./actions";
import {
  actionsCollide,
  buildBindingIndex,
  findBindingConflict,
  KEYBINDINGS_STORAGE_KEY,
  resolveBindings,
  useKeybindingStore,
} from "./keybindingStore";

function resetStore() {
  window.localStorage.clear();
  useKeybindingStore.setState({ overrides: {} });
}

describe("resolveBindings", () => {
  it("returns defaults when there are no overrides", () => {
    const resolved = resolveBindings({});
    expect(resolved["transport.playPause"]).toBe("Space");
    expect(resolved["edit.splitClip"]).toBe("S");
    expect(resolved["edit.splitSong"]).toBe("Shift+S");
    expect(resolved["edit.rename"]).toBe("F2");
  });

  it("lets an override win over the default", () => {
    const resolved = resolveBindings({ "transport.playPause": "Ctrl+P" });
    expect(resolved["transport.playPause"]).toBe("Ctrl+P");
  });

  it("treats a null override as 'unbound'", () => {
    const resolved = resolveBindings({ "edit.copy": null });
    expect(resolved["edit.copy"]).toBeNull();
  });
});

describe("buildBindingIndex", () => {
  it("maps each bound key back to its action and skips unbound", () => {
    const index = buildBindingIndex(resolveBindings({ "edit.copy": null }));
    expect(index.get("Space")).toBe("transport.playPause");
    expect(index.has("Ctrl+C")).toBe(false); // edit.copy was unbound
  });
});

describe("findBindingConflict", () => {
  it("detects an existing owner of a binding", () => {
    // Ctrl+S is project.save by default; asking on behalf of another action
    // must report the clash.
    expect(findBindingConflict({}, "Ctrl+S", "edit.copy")).toBe(
      "project.save",
    );
  });

  it("ignores the action itself", () => {
    expect(findBindingConflict({}, "Ctrl+S", "project.save")).toBeNull();
  });

  it("returns null for a free binding", () => {
    expect(findBindingConflict({}, "Ctrl+Shift+K", "edit.copy")).toBeNull();
  });
});

describe("useKeybindingStore persistence", () => {
  beforeEach(resetStore);

  it("persists only overrides, not the full map", () => {
    useKeybindingStore.getState().setBinding("transport.playPause", "Ctrl+P");
    const raw = window.localStorage.getItem(KEYBINDINGS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      "transport.playPause": "Ctrl+P",
    });
  });

  it("clearBinding stores an explicit null", () => {
    useKeybindingStore.getState().clearBinding("edit.copy");
    expect(useKeybindingStore.getState().overrides["edit.copy"]).toBeNull();
  });

  it("resetBinding drops the override", () => {
    const store = useKeybindingStore.getState();
    store.setBinding("edit.copy", "Ctrl+Shift+C");
    store.resetBinding("edit.copy");
    expect(
      "edit.copy" in useKeybindingStore.getState().overrides,
    ).toBe(false);
  });

  it("resetAll wipes everything", () => {
    const store = useKeybindingStore.getState();
    store.setBinding("edit.copy", "Ctrl+Shift+C");
    store.resetAll();
    expect(useKeybindingStore.getState().overrides).toEqual({});
    expect(window.localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBe("{}");
  });
});

describe("Setlist scope (plan setlist-view, paso 19)", () => {
  it("no two shipped defaults collide", () => {
    const bound = SHORTCUT_ACTIONS.filter((action) => action.defaultBinding);
    for (const a of bound) {
      for (const b of bound) {
        if (a.id >= b.id || a.defaultBinding !== b.defaultBinding) continue;
        expect(actionsCollide(a.id, b.id), `${a.id} vs ${b.id} on ${a.defaultBinding}`).toBe(false);
      }
    }
  });

  it("registers the view shortcut unbound and the performance keys", () => {
    const resolved = resolveBindings({});
    expect(resolved["view.setlist"]).toBeNull();
    expect(resolved["setlist.previousSection"]).toBe("ArrowLeft");
    expect(resolved["setlist.nextSection"]).toBe("ArrowRight");
    expect(resolved["setlist.previousSong"]).toBe("ArrowUp");
    expect(resolved["setlist.nextSong"]).toBe("ArrowDown");
    expect(resolved["setlist.confirmJump"]).toBe("Enter");
  });

  it("keeps scoped keys out of the global index and vice versa", () => {
    const resolved = resolveBindings({});
    const global = buildBindingIndex(resolved);
    const setlist = buildBindingIndex(resolved, "setlist");
    expect(global.get("ArrowLeft")).toBe("edit.nudgeLeft");
    expect(global.has("Enter")).toBe(false);
    expect(setlist.get("ArrowLeft")).toBe("setlist.previousSection");
    expect(setlist.get("Enter")).toBe("setlist.confirmJump");
    expect(setlist.has("Space")).toBe(false);
  });

  it("lets a Setlist key shadow an edit key but not transport or view keys", () => {
    expect(findBindingConflict({}, "S", "setlist.nextSong")).toBeNull();
    expect(findBindingConflict({}, "Space", "setlist.nextSong")).toBe("transport.playPause");
    expect(findBindingConflict({}, "Tab", "setlist.confirmJump")).toBe("view.toggleViewMode");
    // Inside the scope, two actions on one key do fight.
    expect(findBindingConflict({}, "Enter", "setlist.nextSong")).toBe("setlist.confirmJump");
    // And a global edit key over a Setlist one is fine the other way round.
    expect(findBindingConflict({}, "ArrowDown", "edit.nudgeLeft")).toBeNull();
  });
});
