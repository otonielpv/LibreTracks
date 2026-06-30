import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUP_ORDER,
  shortcutGroupLabelKey,
  type ShortcutActionDef,
  type ShortcutActionId,
} from "../keyboard/actions";
import {
  eventToBinding,
  formatBindingForDisplay,
  isMacPlatform,
  isModifierOnlyEvent,
} from "../keyboard/keybinding";
import {
  findBindingConflict,
  resolveBindings,
  useKeybindingStore,
} from "../keyboard/keybindingStore";

// "Atajos" tab inside the Settings modal. Lists every registered action grouped
// by category, shows its current binding, and (for editable actions) lets the
// user re-capture or remove the key. Conflicts are handled Reaper-style: the
// user is warned and can reassign anyway (which unbinds the previous owner).

type CaptureState = {
  actionId: ShortcutActionId;
  /** The chord just captured, awaiting confirm/conflict resolution. */
  candidate: string | null;
  /** Action that currently owns `candidate`, if any. */
  conflictWith: ShortcutActionId | null;
};

export function ShortcutsSettingsTab() {
  const { t } = useTranslation();
  const overrides = useKeybindingStore((state) => state.overrides);
  const setBinding = useKeybindingStore((state) => state.setBinding);
  const clearBinding = useKeybindingStore((state) => state.clearBinding);
  const resetBinding = useKeybindingStore((state) => state.resetBinding);
  const resetAll = useKeybindingStore((state) => state.resetAll);

  const isMac = useMemo(() => isMacPlatform(), []);
  const resolved = useMemo(() => resolveBindings(overrides), [overrides]);

  const [search, setSearch] = useState("");
  const [capture, setCapture] = useState<CaptureState | null>(null);

  const actionLabel = (action: ShortcutActionDef) => t(action.labelKey);

  // While capturing, listen on the window for the next chord. We swallow the
  // event so it doesn't also trigger the shortcut being rebound.
  useEffect(() => {
    if (!capture) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape cancels capture without changing anything.
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCapture(null);
        return;
      }
      if (isModifierOnlyEvent(event)) {
        return; // wait for a real key
      }
      event.preventDefault();
      event.stopPropagation();
      const binding = eventToBinding(event);
      if (!binding) {
        return;
      }
      const conflictWith = findBindingConflict(
        overrides,
        binding,
        capture.actionId,
      );
      setCapture({ actionId: capture.actionId, candidate: binding, conflictWith });
    };
    // Capture phase so we run before the timeline dispatcher's window handler.
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [capture, overrides]);

  const beginCapture = (actionId: ShortcutActionId) => {
    setCapture({ actionId, candidate: null, conflictWith: null });
  };

  const confirmCapture = (stealFromConflict: boolean) => {
    if (!capture?.candidate) {
      return;
    }
    if (capture.conflictWith && stealFromConflict) {
      // Reaper-style steal: unbind the previous owner first.
      clearBinding(capture.conflictWith);
    }
    setBinding(capture.actionId, capture.candidate);
    setCapture(null);
  };

  const normalizedSearch = search.trim().toLowerCase();
  const matchesSearch = (action: ShortcutActionDef): boolean => {
    if (!normalizedSearch) {
      return true;
    }
    const label = actionLabel(action).toLowerCase();
    const binding = (resolved[action.id] ?? "").toLowerCase();
    return (
      label.includes(normalizedSearch) || binding.includes(normalizedSearch)
    );
  };

  const conflictOwnerLabel = (id: ShortcutActionId | null): string => {
    if (!id) {
      return "";
    }
    const def = SHORTCUT_ACTIONS.find((action) => action.id === id);
    return def ? actionLabel(def) : id;
  };

  return (
    <section
      className="lt-settings-tab-panel lt-shortcuts-panel"
      role="tabpanel"
      id="lt-settings-panel-shortcuts"
      aria-labelledby="lt-settings-tab-shortcuts"
    >
      <div className="lt-shortcuts-toolbar">
        <input
          type="search"
          className="lt-shortcuts-search"
          placeholder={t("shortcuts.searchPlaceholder", {
            defaultValue: "Buscar atajo…",
          })}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className="lt-shortcuts-reset-all"
          onClick={() => resetAll()}
        >
          {t("shortcuts.resetAll", { defaultValue: "Restablecer todo" })}
        </button>
      </div>

      <p className="lt-shortcuts-hint">
        {t("shortcuts.hint", {
          defaultValue:
            "Pulsa «Editar» y luego la combinación de teclas. Esc cancela.",
        })}
      </p>

      {SHORTCUT_GROUP_ORDER.map((group) => {
        const actions = SHORTCUT_ACTIONS.filter(
          (action) => action.group === group && matchesSearch(action),
        );
        if (!actions.length) {
          return null;
        }
        return (
          <div key={group} className="lt-shortcuts-group">
            <h3 className="lt-shortcuts-group-title">
              {t(shortcutGroupLabelKey(group))}
            </h3>
            <ul className="lt-shortcuts-list">
              {actions.map((action) => {
                const binding = resolved[action.id];
                const editable = action.editable !== false;
                const isCapturing = capture?.actionId === action.id;
                const isOverridden = action.id in overrides;
                return (
                  <li key={action.id} className="lt-shortcuts-row">
                    <span className="lt-shortcuts-row-label">
                      {actionLabel(action)}
                    </span>

                    {isCapturing ? (
                      <span className="lt-shortcuts-capture">
                        {capture.candidate ? (
                          <>
                            <kbd className="lt-shortcuts-kbd">
                              {formatBindingForDisplay(capture.candidate, isMac)}
                            </kbd>
                            {capture.conflictWith ? (
                              <span className="lt-shortcuts-conflict">
                                {t("shortcuts.conflict", {
                                  action: conflictOwnerLabel(
                                    capture.conflictWith,
                                  ),
                                  defaultValue:
                                    "Ya en uso por «{{action}}».",
                                })}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="lt-shortcuts-confirm"
                              onClick={() =>
                                confirmCapture(Boolean(capture.conflictWith))
                              }
                            >
                              {capture.conflictWith
                                ? t("shortcuts.reassign", {
                                    defaultValue: "Reasignar",
                                  })
                                : t("shortcuts.assign", {
                                    defaultValue: "Asignar",
                                  })}
                            </button>
                            <button
                              type="button"
                              className="lt-shortcuts-cancel"
                              onClick={() => setCapture(null)}
                            >
                              {t("common.cancel", { defaultValue: "Cancelar" })}
                            </button>
                          </>
                        ) : (
                          <span className="lt-shortcuts-listening">
                            {t("shortcuts.listening", {
                              defaultValue: "Pulsa una tecla…",
                            })}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="lt-shortcuts-row-controls">
                        {binding ? (
                          <kbd className="lt-shortcuts-kbd">
                            {formatBindingForDisplay(binding, isMac)}
                          </kbd>
                        ) : (
                          <span className="lt-shortcuts-unbound">
                            {t("shortcuts.unbound", {
                              defaultValue: "Sin asignar",
                            })}
                          </span>
                        )}

                        {editable ? (
                          <>
                            <button
                              type="button"
                              className="lt-shortcuts-edit"
                              onClick={() => beginCapture(action.id)}
                            >
                              {t("shortcuts.edit", { defaultValue: "Editar" })}
                            </button>
                            {binding ? (
                              <button
                                type="button"
                                className="lt-shortcuts-clear"
                                title={t("shortcuts.clear", {
                                  defaultValue: "Quitar atajo",
                                })}
                                onClick={() => clearBinding(action.id)}
                              >
                                ✕
                              </button>
                            ) : null}
                            {isOverridden ? (
                              <button
                                type="button"
                                className="lt-shortcuts-reset"
                                title={t("shortcuts.reset", {
                                  defaultValue: "Restablecer al valor por defecto",
                                })}
                                onClick={() => resetBinding(action.id)}
                              >
                                ↺
                              </button>
                            ) : null}
                          </>
                        ) : (
                          <span className="lt-shortcuts-fixed">
                            {t("shortcuts.fixed", { defaultValue: "Fijo" })}
                          </span>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
