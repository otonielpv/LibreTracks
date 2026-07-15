import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  ariaLabel: string;
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * A portalled panel anchored under a topbar button. Shared by the metronome,
 * voice-guide and pads popovers so the anchor/outside-click/Escape/reposition
 * plumbing lives in one place. Mirrors the behaviour PadsPopover established.
 */
export function PopoverShell({
  open,
  anchorRef,
  ariaLabel,
  onClose,
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );

  const updateAnchor = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Keep the panel on-screen horizontally. Prefer left-aligned to the button,
    // but if that would overflow the right edge, shift left so the panel's right
    // edge lines up with the viewport margin. Buttons near the right edge (the
    // pads trigger sits far right) otherwise get clipped.
    const margin = 12;
    const width = panelRef.current?.offsetWidth ?? 300;
    const maxLeft = window.innerWidth - width - margin;
    const left = Math.max(margin, Math.min(rect.left, maxLeft));
    setAnchor({ top: rect.bottom + 6, left });
  }, [anchorRef]);

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
      // it back open (a close→reopen flicker). Treat any click inside the whole
      // split wrapper as "inside".
      const el =
        target instanceof Element ? target : (target as Node).parentElement;
      if (el?.closest(".lt-topbar-split")) return;
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
      style={{ position: "fixed", top: `${anchor.top}px`, left: `${anchor.left}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
