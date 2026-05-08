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
          {action.label}
        </button>
      ))}
    </div>
  );
}
