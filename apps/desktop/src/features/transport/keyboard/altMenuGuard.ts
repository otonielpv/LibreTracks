/**
 * Stops Windows from eating the input that follows an Alt + wheel gesture.
 *
 * On Windows, releasing Alt without having pressed another key activates the
 * window's menu (this app has no menu bar, so it is the window's system menu).
 * While that mode is on, the window swallows the next input — which is what
 * made Ctrl + wheel look broken right after resizing a track with Alt + wheel,
 * until a click somewhere dismissed it. The wheel is not a key press, so
 * Windows considers the Alt unused no matter how much the page did with it.
 *
 * There is no way to tell the OS "that Alt was used", so the guard cancels the
 * Alt release itself: a cancelled key event is not forwarded to the window
 * procedure, so the menu never activates. It only arms after a wheel or pointer
 * gesture that actually carried Alt (Alt + wheel, Alt-dragging a track's bottom
 * edge), so a plain Alt press anywhere else behaves normally.
 */
export function installAltMenuGuard(): () => void {
  let armed = false;

  const onAltGesture = (event: WheelEvent | PointerEvent) => {
    if (event.altKey) {
      armed = true;
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Alt") {
      // Any other key while Alt is down already counts as "Alt was used", so
      // Windows won't open the menu and the guard has nothing to do.
      armed = false;
      return;
    }
    // Auto-repeat while the user keeps Alt held for more wheel notches.
    if (armed) {
      event.preventDefault();
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (!armed || event.key !== "Alt") {
      return;
    }
    armed = false;
    event.preventDefault();
  };

  // Alt+Tab and friends take the focus away with Alt still down; the release
  // then happens elsewhere and this window must start from a clean slate.
  const onBlur = () => {
    armed = false;
  };

  window.addEventListener("wheel", onAltGesture, {
    capture: true,
    passive: true,
  });
  window.addEventListener("pointerdown", onAltGesture, {
    capture: true,
    passive: true,
  });
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);

  return () => {
    window.removeEventListener("wheel", onAltGesture, { capture: true });
    window.removeEventListener("pointerdown", onAltGesture, { capture: true });
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
  };
}
