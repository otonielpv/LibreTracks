import type { ContextMenuState } from "../types";

type TimelineContextMenusProps = {
  contextMenu: ContextMenuState;
  onDismiss: () => void;
};

export function TimelineContextMenus({
  contextMenu,
  onDismiss,
}: TimelineContextMenusProps) {
  if (!contextMenu) {
    return null;
  }

  return (
    <div
      className="lt-context-menu"
      style={{ left: contextMenu.x, top: contextMenu.y }}
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
