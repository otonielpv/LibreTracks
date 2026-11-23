import { useEffect, useState } from "react";

/**
 * The height left visible above the on-screen keyboard, in CSS px, or null
 * when the browser has no `visualViewport`.
 *
 * Android's WebView does not shrink the window when the keyboard opens
 * (`innerHeight` stays at the full screen, measured on the emulator at
 * iPhone 13 size: 844 with a 541 px visual viewport), so a full-height editor
 * kept its last lines and its Save/Cancel buttons under the keyboard.
 */
export function useVisibleViewportHeight(): number | null {
  const read = () => (typeof window !== "undefined" && window.visualViewport ? window.visualViewport.height : null);
  const [height, setHeight] = useState<number | null>(read);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setHeight(viewport.height);
    update();
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, []);
  return height;
}
