import { useLayoutEffect, useRef, useState } from "react";

import { getUiZoom } from "../../../shared/uiZoom";
import type { ContextMenuState } from "../types";

type TimelineContextMenusProps = {
  contextMenu: ContextMenuState;
  onDismiss: () => void;
};

export function TimelineContextMenus({
  contextMenu,
  onDismiss,
}: TimelineContextMenusProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const anchorX = contextMenu?.x ?? 0;
  const anchorY = contextMenu?.y ?? 0;
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight?: number;
  }>({ left: anchorX, top: anchorY });

  // Keep the menu fully on-screen: opening near the bottom/right edge would
  // clip the lower actions so they can't be clicked. Measure after mount, flip
  // the menu above/left of the anchor when there is more room there, and cap
  // its height to the available space (the CSS makes the body scroll) so it can
  // never spill off the viewport regardless of item count.
  useLayoutEffect(() => {
    if (!contextMenu) {
      return;
    }
    setPosition({ left: anchorX, top: anchorY });
    const element = menuRef.current;
    if (!element || typeof window === "undefined") {
      return;
    }
    // anchorX/Y are in the zoomed element space; rect/innerWidth are real
    // viewport pixels. Convert the anchor to viewport space to reason about
    // available room, then convert the final position back by dividing by zoom.
    const zoom = getUiZoom() || 1;
    const margin = 8;
    const rect = element.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const anchorViewportX = anchorX * zoom;
    const anchorViewportY = anchorY * zoom;

    // Horizontal: flip left of the anchor when it would overflow the right.
    let leftViewport = anchorViewportX;
    if (leftViewport + rect.width + margin > viewportW) {
      leftViewport = Math.max(margin, anchorViewportX - rect.width);
    }
    leftViewport = Math.max(
      margin,
      Math.min(leftViewport, viewportW - rect.width - margin),
    );

    // Vertical: choose whichever side of the anchor has more room, then cap the
    // height to that side so a very tall menu scrolls instead of overflowing.
    const roomBelow = viewportH - anchorViewportY - margin;
    const roomAbove = anchorViewportY - margin;
    let topViewport: number;
    let maxHeight: number;
    if (rect.height <= roomBelow || roomBelow >= roomAbove) {
      topViewport = anchorViewportY;
      maxHeight = roomBelow;
    } else {
      maxHeight = roomAbove;
      topViewport = Math.max(margin, anchorViewportY - Math.min(rect.height, roomAbove));
    }

    setPosition({
      left: leftViewport / zoom,
      top: topViewport / zoom,
      maxHeight: maxHeight / zoom,
    });
  }, [contextMenu, anchorX, anchorY]);

  if (!contextMenu) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className="lt-context-menu"
      style={{
        left: position.left,
        top: position.top,
        maxHeight: position.maxHeight,
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <strong>{contextMenu.title}</strong>
      {contextMenu.actions.map((action) => (
        <button
          key={action.label}
          type="button"
          disabled={action.disabled}
          onClick={() => {
            onDismiss();
            void action.onSelect();
          }}
        >
          {action.swatch ? (
            <span
              className="lt-context-menu-swatch"
              style={{ background: action.swatch }}
              aria-hidden="true"
            />
          ) : null}
          <span className="lt-context-menu-label">{action.label}</span>
          {action.shortcut ? (
            <kbd className="lt-context-menu-shortcut">{action.shortcut}</kbd>
          ) : null}
        </button>
      ))}
    </div>
  );
}
