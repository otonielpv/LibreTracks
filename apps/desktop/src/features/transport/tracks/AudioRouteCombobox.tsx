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
    maxHeight: number | undefined;
  } | null>(null);
  const listId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // El panel se mide DESPUES de pintarse para saber si cabe debajo, asi que
  // hace falta enterarse de cuando aterriza en el DOM.
  const [listMounted, setListMounted] = useState(false);
  const setListNode = useCallback((node: HTMLUListElement | null) => {
    listRef.current = node;
    setListMounted(node !== null);
  }, []);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : value;

  // El desplegable vive en `document.body` con posicion fija, asi que nadie lo
  // recoloca por el: si el disparador esta abajo —el panel de una pista en un
  // telefono apaisado lo esta siempre— la lista se pintaba fuera de la pantalla
  // y sus opciones quedaban inalcanzables. Se abre hacia el lado donde quepa y
  // se recorta al viewport.
  const updateAnchor = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 4;
    const listHeight = listRef.current?.offsetHeight ?? 0;
    const listWidth = listRef.current?.offsetWidth ?? rect.width;
    const spaceBelow = window.innerHeight - rect.bottom - 2 - margin;
    const spaceAbove = rect.top - 2 - margin;
    const openUpwards =
      listHeight > 0 && listHeight > spaceBelow && spaceAbove > spaceBelow;
    const available = Math.max(margin, openUpwards ? spaceAbove : spaceBelow);
    const top = openUpwards
      ? Math.max(margin, rect.top - 2 - Math.min(listHeight, available))
      : rect.bottom + 2;
    const left = Math.max(
      margin,
      Math.min(rect.left, window.innerWidth - listWidth - margin),
    );
    // Solo se impone un alto cuando el hueco es MENOR que la lista: si cabe,
    // manda el tope de cinco opciones que pone el CSS.
    const maxHeight =
      listHeight > 0 && listHeight > available ? available : undefined;
    setAnchor((previous) =>
      previous &&
      previous.top === top &&
      previous.left === left &&
      previous.width === rect.width &&
      previous.maxHeight === maxHeight
        ? previous
        : { top, left, width: rect.width, maxHeight },
    );
  }, []);

  // Close on outside click / Escape, and keep the portalled list anchored
  // when the page scrolls or resizes.
  useEffect(() => {
    if (!open) return;
    updateAnchor();
    // `pointerdown`, no `mousedown`: en iOS el raton de compatibilidad llega
    // DESPUES de levantar el dedo, asi que el menu seguia abierto durante todo
    // el toque y se cerraba tarde.
    const handlePointer = (event: Event) => {
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
    window.addEventListener("pointerdown", handlePointer, true);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleReposition, true);
    window.addEventListener("resize", handleReposition);
    return () => {
      window.removeEventListener("pointerdown", handlePointer, true);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleReposition, true);
      window.removeEventListener("resize", handleReposition);
    };
  }, [open, updateAnchor]);

  // Segunda pasada: ya con la lista en el DOM se sabe cuanto ocupa, y solo
  // entonces se puede decidir si se abre hacia arriba o se recorta.
  useLayoutEffect(() => {
    if (!open || !listMounted) return;
    updateAnchor();
  }, [open, listMounted, updateAnchor, options.length]);

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
            ref={setListNode}
            id={listId}
            role="listbox"
            tabIndex={-1}
            className="lt-audio-route-list"
            // Marca para quien cierre paneles al tocar fuera: esto es SUYO
            // aunque en el DOM cuelgue de `document.body`. Sin ella, el panel
            // de pista se cerraba en el `pointerdown` de la opcion y el click
            // que aplicaba el enrutado no llegaba a existir.
            data-lt-panel-portal=""
            style={{
              position: "fixed",
              top: `${anchor.top}px`,
              left: `${anchor.left}px`,
              ...(anchor.maxHeight === undefined
                ? null
                : { maxHeight: `${anchor.maxHeight}px` }),
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
