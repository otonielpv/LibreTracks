import { describe, expect, it } from "vitest";

import {
  eventToBinding,
  formatBindingForDisplay,
  isModifierOnlyEvent,
} from "./keybinding";

// Minimal KeyboardEvent stand-in. jsdom provides KeyboardEvent but constructing
// one with `code` is fiddly; a plain object with the fields eventToBinding reads
// is enough and keeps the tests fast and explicit.
function keyEvent(
  init: Partial<
    Pick<
      KeyboardEvent,
      "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
    >
  >,
): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("eventToBinding", () => {
  it("upper-cases a plain letter", () => {
    expect(eventToBinding(keyEvent({ key: "s", code: "KeyS" }))).toBe("S");
  });

  it("keeps Shift separate from the letter", () => {
    expect(
      eventToBinding(keyEvent({ key: "s", code: "KeyS", shiftKey: true })),
    ).toBe("Shift+S");
  });

  it("emits a fixed modifier order Ctrl+Alt+Shift", () => {
    expect(
      eventToBinding(
        keyEvent({
          key: "z",
          code: "KeyZ",
          ctrlKey: true,
          shiftKey: true,
          altKey: true,
        }),
      ),
    ).toBe("Ctrl+Alt+Shift+Z");
  });

  it("folds Cmd (Meta) into the Ctrl token", () => {
    expect(eventToBinding(keyEvent({ key: "s", code: "KeyS", metaKey: true }))).toBe(
      "Ctrl+S",
    );
  });

  it("maps the space bar to 'Space' via code", () => {
    expect(eventToBinding(keyEvent({ key: " ", code: "Space" }))).toBe("Space");
    expect(
      eventToBinding(keyEvent({ key: " ", code: "Space", shiftKey: true })),
    ).toBe("Shift+Space");
  });

  it("uses named keys verbatim", () => {
    expect(eventToBinding(keyEvent({ key: "ArrowLeft", code: "ArrowLeft" }))).toBe(
      "ArrowLeft",
    );
    expect(eventToBinding(keyEvent({ key: "Delete", code: "Delete" }))).toBe(
      "Delete",
    );
  });

  it("returns null for a modifier-only press", () => {
    expect(eventToBinding(keyEvent({ key: "Shift", code: "ShiftLeft" }))).toBeNull();
  });
});

describe("isModifierOnlyEvent", () => {
  it("is true for lone modifiers", () => {
    expect(isModifierOnlyEvent(keyEvent({ key: "Control" }))).toBe(true);
    expect(isModifierOnlyEvent(keyEvent({ key: "Meta" }))).toBe(true);
  });

  it("is false for a real key", () => {
    expect(isModifierOnlyEvent(keyEvent({ key: "a" }))).toBe(false);
  });
});

describe("formatBindingForDisplay", () => {
  it("renders plain modifier names on non-mac", () => {
    expect(formatBindingForDisplay("Ctrl+Shift+Z", false)).toBe("Ctrl+Shift+Z");
  });

  it("renders mac glyphs and folds Ctrl to ⌘", () => {
    expect(formatBindingForDisplay("Ctrl+S", true)).toBe("⌘S");
    expect(formatBindingForDisplay("Ctrl+Shift+Z", true)).toBe("⌘⇧Z");
  });

  it("symbolises named keys", () => {
    expect(formatBindingForDisplay("ArrowLeft", false)).toBe("←");
    expect(formatBindingForDisplay("Shift+Space", false)).toBe("Shift+Space");
  });

  it("returns empty string for an unbound action", () => {
    expect(formatBindingForDisplay(null, false)).toBe("");
  });
});
