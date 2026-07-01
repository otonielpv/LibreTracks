import { beforeEach, describe, expect, it } from "vitest";

import {
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
