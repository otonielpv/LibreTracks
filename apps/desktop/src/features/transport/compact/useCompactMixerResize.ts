import { useCallback, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { clampMixerHeight } from "../setlist/useMixerResize";

const STORAGE_KEY = "lt.compactView.mixerHeightPx";
export const COMPACT_MIXER_HEIGHT_VAR = "--lt-compact-mixer-height";

function readStoredHeight(): number | null {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storeHeight(heightPx: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(heightPx));
  } catch {
    // Blocked storage: the height lasts for this session only.
  }
}

/**
 * Dragging the top edge of Compacta's mixer, like Setlist's useMixerResize:
 * during the drag the height goes straight to a CSS variable on the view root
 * (no React state per pointermove); on release it is committed once and
 * remembered in localStorage. `heightPx` null = the stylesheet's default.
 */
export function useCompactMixerResize(rootRef: RefObject<HTMLElement | null>) {
  const [heightPx, setHeightPx] = useState<number | null>(readStoredHeight);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const root = rootRef.current;
      const mixer = root?.querySelector<HTMLElement>(":scope > .lt-compact-mixer");
      if (!root || !mixer || event.button !== 0) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      const startY = event.clientY;
      const startHeight = mixer.getBoundingClientRect().height;
      const viewHeight = root.getBoundingClientRect().height;
      let current = clampMixerHeight(startHeight, viewHeight);
      root.classList.add("is-mixer-sized", "is-resizing-mixer");
      root.style.setProperty(COMPACT_MIXER_HEIGHT_VAR, `${current}px`);
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        current = clampMixerHeight(startHeight - (moveEvent.clientY - startY), viewHeight);
        root.style.setProperty(COMPACT_MIXER_HEIGHT_VAR, `${current}px`);
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        root.classList.remove("is-resizing-mixer");
        setHeightPx(current);
        storeHeight(current);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [rootRef],
  );

  const style: CSSProperties | undefined =
    heightPx !== null ? ({ [COMPACT_MIXER_HEIGHT_VAR]: `${heightPx}px` } as CSSProperties) : undefined;

  return { heightPx, style, onPointerDown };
}
