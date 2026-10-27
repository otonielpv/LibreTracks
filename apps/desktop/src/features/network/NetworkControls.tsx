import type { ReactNode, SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNetworkPermissions } from "./useNetworkPermissions";

/** Covers native fields and custom pointer/keyboard controls without changing layout. */
export function NetworkControls({
  permission,
  children,
}: {
  permission: "control" | "edit" | "files";
  children: ReactNode;
}) {
  const { canControl, canEdit, canUseFiles } = useNetworkPermissions();
  const { t } = useTranslation();
  const allowed = permission === "control" ? canControl : permission === "edit" ? canEdit : canUseFiles;
  if (allowed) return <>{children}</>;
  const block = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <fieldset
      disabled={!allowed}
      aria-disabled={!allowed || undefined}
      title={allowed ? undefined : t(permission === "files" ? "networkSession.guestErrors.notAvailable" : "networkSession.guestErrors.forbidden")}
      style={{ display: "contents", border: 0, padding: 0, margin: 0, minWidth: 0 }}
      onClickCapture={block}
      onDoubleClickCapture={block}
      onPointerDownCapture={block}
      onKeyDownCapture={block}
      onChangeCapture={block}
      onContextMenuCapture={block}
      onDragStartCapture={block}
      onDropCapture={block}
    >
      {children}
    </fieldset>
  );
}
