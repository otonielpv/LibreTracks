import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import {
  createReorderPreview,
  type ReorderAxis,
  type ReorderPreview,
} from "../reorder/reorderPreview";

/** Pointer travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 6;

const BLOCK_SELECTOR = "[data-block-id]";
const DROP_BEFORE_CLASS = "is-drop-before";
const DROP_END_CLASS = "is-drop-end";

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

function clearDropIndicators(list: HTMLElement | null) {
  if (!list) return;
  list.classList.remove(DROP_END_CLASS);
  for (const element of blockElements(list)) element.classList.remove(DROP_BEFORE_CLASS);
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
          const source = list.querySelector<HTMLElement>(
            `[data-block-id="${CSS.escape(blockId)}"]`,
          );
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
      let preview: ReorderPreview | null = null;
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
      track(event, {
        onDragStart: (pointer) => {
          if (list) preview = previewFor(list, axis, null, pointer);
        },
        onDragMove: (x, y) => {
          clearDropIndicators(list);
          if (!list || !preview || !overList(x, y)) {
            gap = -1;
            return;
          }
          gap = preview.gapAt(x, y);
          const elements = blockElements(list);
          if (gap < elements.length) elements[gap].classList.add(DROP_BEFORE_CLASS);
          else list.classList.add(DROP_END_CLASS);
        },
        onDrop: () => {
          clearDropIndicators(list);
          (preview as ReorderPreview | null)?.destroy({ animate: false });
          if (gap >= 0) onInsert(gap, sectionMarkerId);
        },
        onClick: () => onAppend(sectionMarkerId),
        onCancel: () => {
          clearDropIndicators(list);
          (preview as ReorderPreview | null)?.destroy({ animate: false });
        },
      });
    },
    [axis, listRef, onAppend, onInsert, track],
  );

  return { onBlockPointerDown, onPalettePointerDown };
}
