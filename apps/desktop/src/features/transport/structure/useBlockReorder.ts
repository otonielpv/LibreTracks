import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import {
  createReorderPreview,
  type ReorderAxis,
  type ReorderPreview,
} from "../reorder/reorderPreview";

/** Pointer travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 6;

const BLOCK_SELECTOR = "[data-block-id]";
const GHOST_CLASS = "lt-structure-insert-ghost";
const LIFT_CLASS = "lt-structure-insert-lift";

function blockElements(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
}

function previewFor(
  list: HTMLElement,
  axis: ReorderAxis,
  liftSource: HTMLElement | null,
  pointer: { x: number; y: number },
): ReorderPreview {
  return createReorderPreview({
    items: blockElements(list).map((element) => ({
      id: element.dataset.blockId ?? "",
      element,
    })),
    axis,
    liftSource,
    pointer,
  });
}

/** Where a block lands (index in the resulting list) for the gap under the
 * pointer, the same arithmetic as the song and track reorders. */
export function targetIndexForGap(ids: readonly string[], draggedId: string, gap: number): number {
  const from = ids.indexOf(draggedId);
  return from >= 0 && gap > from ? gap - 1 : gap;
}

/**
 * The "gap + ghost" of a palette drag: a translucent copy of the section opens
 * a gap in the strip where it will land, and another copy follows the pointer.
 * The ghost is a plain DOM node React does not know about; it only lives while
 * the drag does, and nothing in React re-renders the strip meanwhile (the
 * working copy only changes on drop, after the ghost is gone).
 */
function createInsertGhost(list: HTMLElement, source: HTMLElement, pointer: { x: number; y: number }) {
  const ghost = document.createElement("li");
  ghost.className = `lt-structure-item ${GHOST_CLASS}`;
  ghost.setAttribute("aria-hidden", "true");
  const ghostChip = source.cloneNode(true) as HTMLElement;
  ghostChip.removeAttribute("role");
  ghost.appendChild(ghostChip);

  const rect = source.getBoundingClientRect();
  const lift = source.cloneNode(true) as HTMLElement;
  lift.removeAttribute("role");
  lift.classList.add(LIFT_CLASS);
  lift.setAttribute("aria-hidden", "true");
  Object.assign(lift.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
  });
  document.body.appendChild(lift);

  let placedAt = -1;
  return {
    /** Puts the ghost in gap `index` (0..n), or takes it out with -1. */
    place(index: number) {
      if (index === placedAt) return;
      placedAt = index;
      if (index < 0) {
        ghost.remove();
        return;
      }
      const blocks = blockElements(list);
      const before = blocks[index] ?? null;
      list.insertBefore(ghost, before);
    },
    moveLift(x: number, y: number) {
      lift.style.transform = `translate3d(${x - pointer.x}px, ${y - pointer.y}px, 0)`;
    },
    destroy() {
      ghost.remove();
      lift.remove();
    },
  };
}

/**
 * Drag to reorder the arrangement's blocks, and to insert a section from the
 * palette where it is dropped. Reuses the song/track reorder preview ("gap +
 * ghost", imperative DOM, no React re-render per frame) instead of adding a
 * drag library.
 */
export function useBlockReorder({
  axis,
  listRef,
  onMove,
  onTap,
  onInsert,
  onAppend,
}: {
  axis: ReorderAxis;
  listRef: { current: HTMLElement | null };
  /** A block was dropped so it ends up at `toIndex`. */
  onMove: (blockId: string, toIndex: number) => void;
  /** A press on a block that never became a drag. */
  onTap: (blockId: string) => void;
  /** A palette section dropped at `index`. */
  onInsert: (index: number, sectionMarkerId: string) => void;
  /** A palette section clicked (not dragged): goes to the end. */
  onAppend: (sectionMarkerId: string) => void;
}) {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const track = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      handlers: {
        onDragStart: (pointer: { x: number; y: number }) => void;
        onDragMove: (x: number, y: number) => void;
        onDrop: (x: number, y: number) => void;
        onClick: () => void;
        onCancel: () => void;
      },
    ) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      cleanupRef.current?.();
      const pointerId = event.pointerId;
      const start = { x: event.clientX, y: event.clientY };
      let dragging = false;
      const move = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        if (!dragging) {
          const travel = Math.hypot(next.clientX - start.x, next.clientY - start.y);
          if (travel < DRAG_THRESHOLD_PX) return;
          dragging = true;
          handlers.onDragStart(start);
        }
        next.preventDefault();
        handlers.onDragMove(next.clientX, next.clientY);
      };
      const up = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        cleanup();
        if (dragging) handlers.onDrop(next.clientX, next.clientY);
        else handlers.onClick();
      };
      const cancel = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        cleanup();
        handlers.onCancel();
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        cleanupRef.current = null;
      };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      cleanupRef.current = cleanup;
    },
    [],
  );

  /** Attach to a block (or to its handle, where dragging the rest of the
   * block must scroll instead). */
  const onBlockPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, blockId: string) => {
      const list = listRef.current;
      if (!list) return;
      event.stopPropagation();
      let preview: ReorderPreview | null = null;
      let target = -1;
      track(event, {
        onDragStart: (pointer) => {
          const source =
            blockElements(list).find((element) => element.dataset.blockId === blockId) ??
            null;
          preview = previewFor(list, axis, source, pointer);
        },
        onDragMove: (x, y) => {
          if (!preview) return;
          const ids = preview.ids;
          target = targetIndexForGap(ids, blockId, preview.gapAt(x, y));
          const order = ids.filter((id) => id !== blockId);
          order.splice(target, 0, blockId);
          preview.render(order, new Set([blockId]));
          preview.moveLift(x, y);
        },
        onDrop: () => {
          const ids = preview?.ids ?? [];
          preview?.destroy({ animate: false });
          if (target >= 0 && target !== ids.indexOf(blockId)) onMove(blockId, target);
        },
        onClick: () => onTap(blockId),
        onCancel: () => (preview as ReorderPreview | null)?.destroy({ animate: true }),
      });
    },
    [axis, listRef, onMove, onTap, track],
  );

  /** Attach to a palette chip. */
  const onPalettePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, sectionMarkerId: string) => {
      const list = listRef.current;
      const chip = event.currentTarget;
      let preview: ReorderPreview | null = null;
      let ghost: ReturnType<typeof createInsertGhost> | null = null;
      let gap = -1;
      const overList = (x: number, y: number) => {
        const rect = list?.getBoundingClientRect();
        if (!rect) return false;
        const margin = 24;
        return (
          x >= rect.left - margin &&
          x <= rect.right + margin &&
          y >= rect.top - margin &&
          y <= rect.bottom + margin
        );
      };
      const finish = () => {
        ghost?.destroy();
        ghost = null;
        (preview as ReorderPreview | null)?.destroy({ animate: false });
      };
      track(event, {
        onDragStart: (pointer) => {
          if (!list) return;
          // Measured BEFORE the ghost exists: the gap under the pointer is
          // decided against the starting layout, so opening the gap does not
          // make the target oscillate (same rule as the song/track reorder).
          preview = previewFor(list, axis, null, pointer);
          ghost = createInsertGhost(list, chip, pointer);
        },
        onDragMove: (x, y) => {
          ghost?.moveLift(x, y);
          if (!list || !preview || !overList(x, y)) {
            gap = -1;
            ghost?.place(-1);
            return;
          }
          gap = preview.gapAt(x, y);
          ghost?.place(gap);
        },
        onDrop: () => {
          finish();
          if (gap >= 0) onInsert(gap, sectionMarkerId);
        },
        onClick: () => onAppend(sectionMarkerId),
        onCancel: finish,
      });
    },
    [axis, listRef, onAppend, onInsert, track],
  );

  return { onBlockPointerDown, onPalettePointerDown };
}
