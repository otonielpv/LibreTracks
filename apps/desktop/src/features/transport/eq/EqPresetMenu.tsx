import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";

import type { EqPreset, TrackEq } from "@libretracks/shared/models";

import type { TrackEqHandlers } from "../tracks/trackEqHandlers";

/**
 * Desplegable «Presets» de la cabecera del editor (plan track-eq-2, paso 01).
 *
 * - Cargar uno llama a `onLoad` con su curva: el editor la confirma con su
 *   commit de siempre (un paso de deshacer).
 * - «Guardar como…» guarda `getCurrent()`, el borrador del editor, que lleva
 *   una Q de rueda aunque aún no haya hecho commit.
 * - La lista se lee al abrir: cada máquina tiene su biblioteca.
 */
export function EqPresetMenu({
  handlers,
  getCurrent,
  onLoad,
}: {
  handlers: Pick<TrackEqHandlers, "listPresets" | "savePreset" | "deletePreset">;
  getCurrent: () => TrackEq;
  onLoad: (eq: TrackEq) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<EqPreset[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFailed(false);
    handlersRef.current
      .listPresets()
      .then((list) => {
        if (!cancelled) setPresets(list);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    const onDocPointerDown = (event: PointerEvent | MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocPointerDown);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onDocPointerDown);
    };
  }, [open]);

  const presetName = (preset: EqPreset) =>
    preset.factory ? t(`eq.presets.names.${preset.id}`, { defaultValue: preset.name }) : preset.name;

  const load = (preset: EqPreset) => {
    setOpen(false);
    onLoad(preset.eq);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void handlersRef.current
      .savePreset(trimmed, getCurrent())
      .then((list) => {
        setPresets(list);
        setNaming(false);
        setName("");
      })
      .catch(() => setFailed(true));
  };

  const remove = (preset: EqPreset) => {
    void handlersRef.current
      .deletePreset(preset.id)
      .then(setPresets)
      .catch(() => setFailed(true));
  };

  const factory = presets?.filter((p) => p.factory) ?? [];
  const user = presets?.filter((p) => !p.factory) ?? [];

  return (
    <div className="lt-eq-presets" ref={rootRef}>
      <button
        type="button"
        className="lt-eq-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t("eq.presets.title")}
      </button>
      {open ? (
        <div className="lt-eq-presets-menu" role="menu" aria-label={t("eq.presets.title")}>
          {failed ? <p className="lt-eq-presets-note">{t("eq.presets.loadFailed")}</p> : null}
          <p className="lt-eq-presets-heading">{t("eq.presets.factory")}</p>
          {factory.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="menuitem"
              className="lt-eq-presets-item"
              onClick={() => load(preset)}
            >
              {presetName(preset)}
            </button>
          ))}
          <p className="lt-eq-presets-heading">{t("eq.presets.user")}</p>
          {presets && user.length === 0 ? (
            <p className="lt-eq-presets-note">{t("eq.presets.empty")}</p>
          ) : null}
          {user.map((preset) => (
            <div key={preset.id} className="lt-eq-presets-row">
              <button
                type="button"
                role="menuitem"
                className="lt-eq-presets-item"
                onClick={() => load(preset)}
              >
                {preset.name}
              </button>
              <button
                type="button"
                className="lt-eq-presets-delete"
                aria-label={t("eq.presets.delete", { name: preset.name })}
                onClick={() => remove(preset)}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  delete
                </span>
              </button>
            </div>
          ))}
          {naming ? (
            <form className="lt-eq-presets-save" onSubmit={save}>
              <input
                autoFocus
                value={name}
                maxLength={60}
                placeholder={t("eq.presets.namePlaceholder")}
                aria-label={t("eq.presets.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" className="lt-eq-button" disabled={!name.trim()}>
                {t("eq.presets.save")}
              </button>
              <button type="button" className="lt-eq-button" onClick={() => setNaming(false)}>
                {t("eq.presets.cancel")}
              </button>
            </form>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="lt-eq-presets-item is-action"
              onClick={() => setNaming(true)}
            >
              {t("eq.presets.saveAs")}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
