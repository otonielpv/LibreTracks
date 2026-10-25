import { memo, useCallback, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useDismissOnBack } from "../mobile/backNavigation";
import { useSetlistStore, type SetlistEditMode } from "./setlistStore";
import type { SetlistLayoutClass } from "./useSetlistLayout";

export type SetlistEditModeEntry = {
  mode: Exclude<SetlistEditMode, null>;
  labelKey: string;
  content: ReactNode;
};

type SetlistEditDrawerProps = {
  layout: SetlistLayoutClass;
  songName: string | null;
  /** Only the modes whose step exists; each one brings its own content. */
  modes: SetlistEditModeEntry[];
};

/** A modal dialog is open on top: Esc belongs to it, not to the edit mode. */
function modalIsOpen() {
  return Boolean(
    document.querySelector(
      "[aria-modal='true'], .lt-context-menu, .lt-modal-backdrop, .lt-dialog-backdrop",
    ),
  );
}

/**
 * The Edit drawer (Playback's «Edit»): a side panel in `wide`, a bottom sheet
 * in `medium` and a full screen in `short`, with one tab per edit mode. Esc
 * leaves edit mode unless a modal is open; Android «back» closes it.
 */
function SetlistEditDrawerComponent({ layout, songName, modes }: SetlistEditDrawerProps) {
  const { t } = useTranslation();
  const editMode = useSetlistStore((state) => state.editMode);
  const setEditMode = useSetlistStore((state) => state.setEditMode);
  const close = useCallback(() => setEditMode(null), [setEditMode]);
  useDismissOnBack(close, editMode !== null);

  useEffect(() => {
    if (editMode === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || modalIsOpen()) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, editMode]);

  const active = modes.find((entry) => entry.mode === editMode) ?? modes[0] ?? null;

  return (
    <div className={`lt-setlist-drawer is-${layout}`} role="dialog" aria-label={t("setlistView.edit.title")}>
      <header className="lt-setlist-drawer-header">
        {layout === "short" ? (
          <button
            type="button"
            className="lt-setlist-settings-button"
            aria-label={t("setlistView.edit.close")}
            onClick={close}
          >
            <span className="material-symbols-outlined" aria-hidden="true">chevron_left</span>
          </button>
        ) : null}
        <strong className="lt-setlist-drawer-title">
          {songName ? t("setlistView.edit.heading", { name: songName }) : t("setlistView.edit.title")}
        </strong>
        <div className="lt-setlist-drawer-modes" role="tablist" aria-label={t("setlistView.edit.modes.label")}>
          {modes.map((entry) => (
            <button
              key={entry.mode}
              type="button"
              role="tab"
              aria-selected={entry.mode === active?.mode}
              className={`lt-setlist-tab${entry.mode === active?.mode ? " is-active" : ""}`}
              onClick={() => setEditMode(entry.mode)}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
        {layout !== "short" ? (
          <button
            type="button"
            className="lt-setlist-settings-button"
            aria-label={t("setlistView.edit.close")}
            onClick={close}
          >
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        ) : null}
      </header>
      <div className="lt-setlist-drawer-body">{active?.content}</div>
    </div>
  );
}

export const SetlistEditDrawer = memo(SetlistEditDrawerComponent);

/** The «Edit» toggle of the view's header. */
export function SetlistEditButton() {
  const { t } = useTranslation();
  const editMode = useSetlistStore((state) => state.editMode);
  const setEditMode = useSetlistStore((state) => state.setEditMode);
  const editing = editMode !== null;
  return (
    <button
      type="button"
      className={`lt-setlist-edit-button${editing ? " is-active" : ""}`}
      aria-pressed={editing}
      onClick={() => setEditMode(editing ? null : "song")}
    >
      <span className="material-symbols-outlined" aria-hidden="true">edit</span>
      <span>{editing ? t("setlistView.edit.done") : t("setlistView.edit.button")}</span>
    </button>
  );
}
