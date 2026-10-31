import { useTranslation } from "react-i18next";

import { openMixSceneEditor } from "./mixSceneEditorStore";

/**
 * "Escenas de mezcla…" in the phone's file menu (the side rail's
 * Archivo): on a phone there is no FILE menu, and scenes must not need an
 * automation track to be created.
 */
export function MixScenesMenuItem({
  disabled,
  onSelected,
}: {
  disabled: boolean;
  onSelected: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onSelected();
        openMixSceneEditor();
      }}
    >
      <span className="material-symbols-outlined">bookmarks</span>
      {t("transport.menu.mixScenes")}
    </button>
  );
}
