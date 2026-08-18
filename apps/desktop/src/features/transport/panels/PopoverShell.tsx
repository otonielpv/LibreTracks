import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  calculatePopoverAnchor,
  type PopoverAnchor,
} from "./popoverPosition";

type Props = {
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  ariaLabel: string;
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * A portalled panel anchored above or below its trigger according to the
 * available viewport space. Shared by metronome and voice-guide popovers.
 */
export function PopoverShell({
  open,
  anchorRef,
  ariaLabel,
  onClose,
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  const updateAnchor = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Keep the panel on-screen horizontally. Prefer left-aligned to the button,
    // but if that would overflow the right edge, shift left so the panel's right
    // edge lines up with the viewport margin. Buttons near the right edge (the
    // pads trigger sits far right) otherwise get clipped.
    const width = panelRef.current?.offsetWidth ?? 300;
    const height = panelRef.current?.scrollHeight ?? 420;
    setAnchor(
      calculatePopoverAnchor(
        rect,
        width,
        height,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (open && anchor) updateAnchor();
  }, [open, anchor?.placement, updateAnchor]);

  useEffect(() => {
    if (!open) return;
    updateAnchor();
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // The trigger is a split control: the main toggle button (anchorRef) plus
      // a caret button that opens/closes this popover. The caret lives outside
      // anchorRef, so without this the caret's mousedown would count as an
      // outside click and close the popover — then its own click would toggle
      // it back open (a close→reopen flicker). Treat a click inside OUR OWN
      // split wrapper as "inside" — but only ours: clicking a sibling popover's
      // trigger (another .lt-topbar-split) must still close this one, otherwise
      // opening the metronome popover leaves the voice-guide popover open.
      const el =
        target instanceof Element ? target : (target as Node).parentElement;
      const ownSplit = anchorRef.current?.closest(".lt-topbar-split") ?? null;
      const clickedSplit = el?.closest(".lt-topbar-split") ?? null;
      if (clickedSplit && clickedSplit === ownSplit) return;
      if (
        !panelRef.current?.contains(target) &&
        !anchorRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const reposition = () => updateAnchor();
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, updateAnchor, anchorRef, onClose]);

  if (!open || !anchor) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="lt-pads-popover"
      role="dialog"
      aria-label={ariaLabel}
      data-placement={anchor.placement}
      style={{
        position: "fixed",
        top: `${anchor.top}px`,
        left: `${anchor.left}px`,
        maxHeight: `${anchor.maxHeight}px`,
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
