import { afterEach, describe, expect, it } from "vitest";

import { installAltMenuGuard } from "./altMenuGuard";

/**
 * The guard's whole job: after an Alt + wheel gesture, the Alt release must be
 * cancelled so Windows does not activate the window menu and swallow the next
 * input. Every other Alt press has to keep behaving normally.
 */

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

function install() {
  uninstall = installAltMenuGuard();
}

function wheel(init: WheelEventInit) {
  window.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }),
  );
}

/** Dispatches the key event and reports whether the guard cancelled it. */
function key(type: "keydown" | "keyup", init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("installAltMenuGuard", () => {
  it("cancels the Alt release that follows an Alt + wheel gesture", () => {
    install();

    wheel({ deltaY: -100, altKey: true });

    expect(key("keyup", { key: "Alt" })).toBe(true);
  });

  it("leaves a plain Alt press alone", () => {
    install();

    expect(key("keydown", { key: "Alt" })).toBe(false);
    expect(key("keyup", { key: "Alt" })).toBe(false);
  });

  it("leaves the Alt release alone after a wheel without Alt", () => {
    install();

    wheel({ deltaY: -100 });

    expect(key("keyup", { key: "Alt" })).toBe(false);
  });

  it("cancels the Alt release after an Alt-drag too", () => {
    // Alt-dragging a track's bottom edge (resize every row) is the same trap:
    // Alt goes down and up with no key press in between.
    install();

    // jsdom has no PointerEvent; the guard only reads `altKey`, which a
    // MouseEvent of the same type carries just as well.
    window.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, altKey: true }),
    );

    expect(key("keyup", { key: "Alt" })).toBe(true);
  });

  it("only swallows one release, not every later one", () => {
    install();

    wheel({ deltaY: -100, altKey: true });
    expect(key("keyup", { key: "Alt" })).toBe(true);
    expect(key("keyup", { key: "Alt" })).toBe(false);
  });

  it("stands down once another key is pressed with Alt held", () => {
    // Alt+S and friends: Windows already treats the Alt as used, and the
    // shortcut's own handler must see an uncancelled release.
    install();

    wheel({ deltaY: -100, altKey: true });
    key("keydown", { key: "s", altKey: true });

    expect(key("keyup", { key: "Alt" })).toBe(false);
  });

  it("stands down when the window loses focus with Alt held (Alt+Tab)", () => {
    install();

    wheel({ deltaY: -100, altKey: true });
    window.dispatchEvent(new Event("blur"));

    expect(key("keyup", { key: "Alt" })).toBe(false);
  });

  it("stops listening once uninstalled", () => {
    install();

    wheel({ deltaY: -100, altKey: true });
    uninstall?.();
    uninstall = null;

    expect(key("keyup", { key: "Alt" })).toBe(false);
  });
});
