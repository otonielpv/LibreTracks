import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { useDismissOnBack } from "../mobile/backNavigation";
import { requestEditMode, useSetlistStore, type SetlistEditMode } from "./setlistStore";
import type { SetlistLayoutClass } from "./useSetlistLayout";

export type SetlistEditModeEntry = {
  mode: Exclude<SetlistEditMode, null>;
  labelKey: string;
  /** Material Symbols icon of the mode's tab. */
  icon: string;
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
 * The Edit panel (Playback's «Edit»): a full-height side panel in `wide` and
 * `medium` (like Ableton's inspector, the song band and the console stay in
 * view) and a full screen in `short`, with one tab per edit mode.
 *
 * Accessible as a dialog: labelled by its heading, focus goes into it when
 * it opens, the tabs are a real tablist (arrow keys, Home/End) tied to their
 * tabpanel, Esc leaves edit mode unless a modal is open, and Android «back»
 * closes it.
 */
function SetlistEditDrawerComponent({ layout, songName, modes }: SetlistEditDrawerProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const panelId = `${baseId}-panel`;
  const rootRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const editMode = useSetlistStore((state) => state.editMode);
  const close = useCallback(() => void requestEditMode(null), []);
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

  // Focus into the panel when it opens (not on every mode change).
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const active = modes.find((entry) => entry.mode === editMode) ?? modes[0] ?? null;

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const index = modes.findIndex((entry) => entry.mode === active?.mode);
    const target =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (index + 1) % modes.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (index - 1 + modes.length) % modes.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? modes.length - 1
              : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = modes[target];
    void requestEditMode(next.mode).then(() => tabRefs.current.get(next.mode)?.focus());
  };

  return (
    <section
      ref={rootRef}
      className={`lt-setlist-drawer is-${layout}`}
      role="dialog"
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <header className="lt-setlist-drawer-header">
        {layout === "short" ? (
          <button
            type="button"
            className="lt-setlist-drawer-close"
            aria-label={t("setlistView.edit.close")}
            title={t("setlistView.edit.close")}
            onClick={close}
          >
            <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
          </button>
        ) : null}
        <h2 id={headingId} className="lt-setlist-drawer-title">
          <span className="material-symbols-outlined" aria-hidden="true">edit</span>
          <span>{songName ? t("setlistView.edit.heading", { name: songName }) : t("setlistView.edit.title")}</span>
        </h2>
        {layout !== "short" ? (
          <button
            type="button"
            className="lt-setlist-drawer-close"
            aria-label={t("setlistView.edit.close")}
            title={t("setlistView.edit.close")}
            onClick={close}
          >
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        ) : null}
      </header>
      <div className="lt-setlist-drawer-modes" role="tablist" aria-label={t("setlistView.edit.modes.label")}>
        {modes.map((entry) => {
          const selected = entry.mode === active?.mode;
          return (
            <button
              key={entry.mode}
              ref={(element) => {
                if (element) tabRefs.current.set(entry.mode, element);
                else tabRefs.current.delete(entry.mode);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${entry.mode}`}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              className={`lt-setlist-drawer-tab${selected ? " is-active" : ""}`}
              title={t(entry.labelKey)}
              onClick={() => void requestEditMode(entry.mode)}
              onKeyDown={onTabKeyDown}
            >
              <span className="material-symbols-outlined" aria-hidden="true">{entry.icon}</span>
              <span className="lt-setlist-drawer-tab-label">{t(entry.labelKey)}</span>
            </button>
          );
        })}
      </div>
      <div
        id={panelId}
        className={`lt-setlist-drawer-body${active?.mode === "sections" ? " is-sections-mode" : ""}`}
        role="tabpanel"
        aria-labelledby={active ? `${baseId}-tab-${active.mode}` : undefined}
      >
        {active?.content}
      </div>
    </section>
  );
}

export const SetlistEditDrawer = memo(SetlistEditDrawerComponent);

/** The «Edit» toggle of the view's header. */
export function SetlistEditButton() {
  const { t } = useTranslation();
  const editMode = useSetlistStore((state) => state.editMode);
  const editing = editMode !== null;
  const label = editing ? t("setlistView.edit.done") : t("setlistView.edit.button");
  return (
    <button
      type="button"
      className={`lt-setlist-edit-button${editing ? " is-active" : ""}`}
      aria-pressed={editing}
      title={editing ? t("setlistView.edit.doneTitle") : t("setlistView.edit.buttonTitle")}
      onClick={() => void requestEditMode(editing ? null : "song")}
    >
      <span className="material-symbols-outlined" aria-hidden="true">{editing ? "check" : "edit"}</span>
      <span>{label}</span>
    </button>
  );
}
