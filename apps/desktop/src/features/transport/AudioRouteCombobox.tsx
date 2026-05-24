import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

type RouteOption = { value: string; label: string };

type Props = {
  value: string;
  options: RouteOption[];
  ariaLabel: string;
  onChange: (value: string) => void;
};

function AudioRouteComboboxImpl({ value, options, ariaLabel, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Anchor rect for the portalled listbox. Recomputed on open and on scroll
  // / resize so the dropdown stays under the trigger even when the surrounding
  // track headers pane scrolls.
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const listId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : value;

  const updateAnchor = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ top: rect.bottom + 2, left: rect.left, width: rect.width });
  }, []);

  // Close on outside click / Escape, and keep the portalled list anchored
  // when the page scrolls or resizes.
  useEffect(() => {
    if (!open) return;
    updateAnchor();
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !buttonRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const handleReposition = () => updateAnchor();
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleReposition, true);
    window.addEventListener("resize", handleReposition);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleReposition, true);
      window.removeEventListener("resize", handleReposition);
    };
  }, [open, updateAnchor]);

  // When opening, focus the listbox so arrow keys work, and pre-select the
  // currently active route option.
  useLayoutEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    listRef.current?.focus();
  }, [open, selectedIndex]);

  // Keep the active item in view inside the scrollable list.
  useLayoutEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return;
    const node = listRef.current.children.item(activeIndex) as
      | HTMLElement
      | null;
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const commit = useCallback(
    (next: string) => {
      onChange(next);
      setOpen(false);
      buttonRef.current?.focus();
    },
    [onChange],
  );

  const onButtonKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (activeIndex >= 0 && activeIndex < options.length) {
        commit(options[activeIndex].value);
      }
    }
  };

  return (
    <div
      className="lt-audio-route-combobox"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={buttonRef}
        type="button"
        className="lt-audio-route-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={onButtonKeyDown}
      >
        <span className="lt-audio-route-trigger-label">{selectedLabel}</span>
        <span className="lt-audio-route-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && anchor &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            className="lt-audio-route-list"
            style={{
              position: "fixed",
              top: `${anchor.top}px`,
              left: `${anchor.left}px`,
              // Use the trigger width as a lower bound; allow the panel to
              // grow with the option labels so "Ext. Out 12-13" doesn't get
              // truncated. Capped to keep narrow tracks from spilling across
              // the entire viewport.
              minWidth: `${anchor.width}px`,
              maxWidth: `${Math.max(anchor.width * 2.5, 280)}px`,
              width: "max-content",
            }}
            aria-activedescendant={
              activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined
            }
            onKeyDown={onListKeyDown}
            onClick={(event) => event.stopPropagation()}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              const isActive = index === activeIndex;
              return (
                <li
                  key={option.value}
                  id={`${listId}-opt-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  className={[
                    "lt-audio-route-option",
                    isSelected ? "is-selected" : "",
                    isActive ? "is-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(option.value)}
                >
                  {option.label}
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}

export const AudioRouteCombobox = memo(AudioRouteComboboxImpl);
