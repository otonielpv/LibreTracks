// Editor de patrones a pantalla completa (plan drum-loops, paso 08):
// cabecera con nombre, variación A-D, ▶ escuchar (el motor, sin guardar),
// deshacer/rehacer local, Guardar ▾ y cerrar (pregunta si hay cambios).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DrumKit, LoopPattern } from "@libretracks/shared/models";

import { isMobileApp, previewLoopPattern, setLoopPlaying } from "../desktopApi";
import { LoopPatternSettings } from "./LoopPatternSettings";
import { VARIATION_LETTERS } from "./LoopRows";
import { LoopStepGrid } from "./LoopStepGrid";
import { normalizePattern, stepCount, stepsPerBar, syncRowsToKit, withKit } from "./patternOps";
import type { RhythmLayoutClass } from "./useRhythmLayout";

export type LoopEditorSaveTarget = "library" | "song" | "new";

type LoopEditorProps = {
  pattern: LoopPattern;
  /** Kit con el que se abre el patrón (y reserva si no está en `kits`). */
  kit: DrumKit;
  /** Kits de la biblioteca para elegir; sin ellos no hay selector. */
  kits?: DrumKit[];
  layoutClass: RhythmLayoutClass;
  touch?: boolean;
  /** Región para «Asignar a esta canción»; sin ella la opción no aparece. */
  songRegionId?: string | null;
  onSave: (pattern: LoopPattern, target: LoopEditorSaveTarget) => Promise<void> | void;
  onClose: () => void;
  /** Confirmación al cerrar con cambios (inyectable en tests). */
  confirmDiscard?: () => boolean;
  newId?: () => string;
  /** Abre el editor de kits: `kit` para editar uno de la biblioteca, `null`
   * para crear uno. `select` pone en el patrón el kit guardado si es otro. */
  onEditKit?: (kit: DrumKit | null, select: (kit: DrumKit) => void) => void;
};

const NEW_KIT = "__new_kit__";

function visibleStepsFor(layout: RhythmLayoutClass, pattern: LoopPattern): number {
  const bar = stepsPerBar(pattern);
  return layout === "wide" ? bar * 2 : bar;
}

export function LoopEditor({
  pattern: initial,
  kit: openedKit,
  kits = [],
  layoutClass,
  touch = isMobileApp,
  songRegionId,
  onSave,
  onClose,
  confirmDiscard,
  newId = () => `pattern-${Date.now().toString(36)}`,
  onEditKit,
}: LoopEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => normalizePattern(initial, openedKit));
  const [past, setPast] = useState<LoopPattern[]>([]);
  const [future, setFuture] = useState<LoopPattern[]>([]);
  const [variation, setVariation] = useState(0);
  const [page, setPage] = useState(0);
  const [listening, setListening] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  // En el teléfono los ajustes (compases, swing…) van plegados: abiertos se
  // comían media pantalla y no dejaban ver la rejilla.
  const collapsibleSettings = layoutClass === "short";
  const [settingsOpen, setSettingsOpen] = useState(!collapsibleSettings);
  const [saved, setSaved] = useState(draft);
  const dirty = draft !== saved;

  // El kit sale del propio borrador, así deshacer también deshace un cambio
  // de kit. `known` guarda los recién creados por si la biblioteca aún no
  // los trae en este render.
  const known = useRef(new Map<string, DrumKit>());
  const kitRef = draft.kit;
  const kit =
    kitRef.kind === "embedded"
      ? kitRef.kit
      : (kits.find((k) => k.id === kitRef.kitId) ??
        known.current.get(kitRef.kitId) ??
        openedKit);

  // Editar el kit con el patrón abierto: los sonidos nuevos salen como filas
  // vacías y los borrados desaparecen. No cuenta como cambio sin guardar.
  const [kitSeen, setKitSeen] = useState(kit);
  if (kitSeen !== kit) {
    const refId = (p: LoopPattern) => (p.kit.kind === "embedded" ? p.kit.kit.id : p.kit.kitId);
    const sameKit = kitSeen.id === kit.id;
    const sync = (p: LoopPattern) => (sameKit && refId(p) === kit.id ? syncRowsToKit(p, kitSeen, kit) : p);
    setKitSeen(kit);
    const synced = sync(draft);
    setDraft(synced);
    setSaved(saved === draft ? synced : sync(saved));
    setPast((list) => list.map(sync));
    setFuture((list) => list.map(sync));
  }

  const visible = visibleStepsFor(layoutClass, draft);
  const pages = Math.max(1, Math.ceil(stepCount(draft) / visible));
  const currentPage = Math.min(page, pages - 1);

  const apply = (next: LoopPattern) => {
    if (next === draft) return;
    setPast((p) => [...p.slice(-49), draft]);
    setFuture([]);
    setDraft(next);
  };

  // `select` puede llegar más tarde (al guardar el editor de kits): usa
  // siempre el borrador y el `apply` del último render.
  const latest = useRef({ draft, apply });
  latest.current = { draft, apply };
  const selectKit = (next: DrumKit) => {
    known.current.set(next.id, next);
    const { draft: current, apply: applyLatest } = latest.current;
    applyLatest(withKit(current, next, { kind: "library", kitId: next.id }));
  };
  const libraryKit = kits.some((k) => k.id === kit.id);
  const kitOptions = libraryKit || kitRef.kind === "embedded" ? kits : [kit, ...kits];

  // Mientras se escucha, cada cambio suena ya (sin guardar).
  useEffect(() => {
    if (listening) void previewLoopPattern(draft).catch(() => {});
  }, [draft, listening]);
  useEffect(
    () => () => {
      void previewLoopPattern(null).catch(() => {});
    },
    [],
  );

  const toggleListen = async () => {
    const next = !listening;
    setListening(next);
    await previewLoopPattern(next ? draft : null).catch(() => {});
    await setLoopPlaying(next).catch(() => {});
  };

  const save = async (target: LoopEditorSaveTarget) => {
    setSaveOpen(false);
    const pattern = target === "new" ? { ...draft, id: newId() } : draft;
    await onSave(normalizePattern(pattern, kit), target);
    setSaved(draft);
  };

  const close = () => {
    if (dirty) {
      const ok = confirmDiscard ? confirmDiscard() : window.confirm(t("rhythm.editor.discard"));
      if (!ok) return;
    }
    onClose();
  };

  return (
    <div
      className={`lt-rhythm-backdrop lt-rhythm-backdrop--${layoutClass}`}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
    <div
      className={["lt-loop-editor", `lt-loop-editor--${layoutClass}`, touch ? "is-touch" : ""].join(" ")}
      role="dialog"
      aria-modal="true"
      aria-label={t("rhythm.editor.title")}
      data-testid="loop-editor"
      data-layout={layoutClass}
    >
      <div className="lt-loop-editor__header">
        <div className="lt-loop-editor__group lt-loop-editor__identity">
          <input
            className="lt-loop-editor__name"
            aria-label={t("rhythm.editor.name")}
            value={draft.name}
            onChange={(event) => apply({ ...draft, name: event.target.value })}
          />
          <span className="lt-loop-editor__kit">
            <span className="lt-rhythm-field__label">{t("rhythm.editor.kit")}</span>
            {kits.length > 0 && onEditKit ? (
              <select
                className="lt-loop-editor__kit-select"
                aria-label={t("rhythm.editor.kit")}
                value={kitRef.kind === "library" ? kit.id : ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === NEW_KIT) {
                    onEditKit(null, selectKit);
                    return;
                  }
                  const next = kits.find((k) => k.id === value);
                  if (next) selectKit(next);
                }}
              >
                {kitRef.kind === "embedded" ? <option value="">{kit.name}</option> : null}
                {kitOptions.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
                <option value={NEW_KIT}>{t("rhythm.kit.create")}</option>
              </select>
            ) : (
              <span className="lt-loop-editor__kit-name">{kit.name}</span>
            )}
            {onEditKit && libraryKit ? (
              <button type="button" className="lt-loop-editor__link" onClick={() => onEditKit(kit, selectKit)}>
                {t("rhythm.kit.edit")}
              </button>
            ) : null}
          </span>
        </div>
        <div className="lt-loop-editor__group">
          <span className="lt-rhythm-field__label">{t("rhythm.editor.variation")}</span>
          <div className="lt-loop-editor__segmented" role="group" aria-label={t("rhythm.editor.variation")}>
            {VARIATION_LETTERS.map((letter, index) => (
              <button
                key={letter}
                type="button"
                className={index === variation ? "is-active" : ""}
                aria-pressed={index === variation}
                onClick={() => setVariation(index)}
              >
                {letter}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={listening ? "lt-loop-editor__play is-playing" : "lt-loop-editor__play"}
          aria-pressed={listening}
          aria-label={t("rhythm.editor.listen")}
          onClick={() => void toggleListen()}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {listening ? "stop" : "play_arrow"}
          </span>
        </button>
        {collapsibleSettings ? (
          <button
            type="button"
            className={settingsOpen ? "lt-loop-editor__icon is-active" : "lt-loop-editor__icon"}
            aria-label={t("rhythm.editor.settings")}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">tune</span>
          </button>
        ) : null}
        <span className="lt-rhythm-header__spacer" />
        <div className="lt-loop-editor__group">
          <button
            type="button"
            className="lt-loop-editor__icon"
            aria-label={t("rhythm.editor.undo")}
            disabled={past.length === 0}
            onClick={() => {
              const previous = past[past.length - 1];
              if (!previous) return;
              setPast(past.slice(0, -1));
              setFuture([draft, ...future]);
              setDraft(previous);
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">undo</span>
          </button>
          <button
            type="button"
            className="lt-loop-editor__icon"
            aria-label={t("rhythm.editor.redo")}
            disabled={future.length === 0}
            onClick={() => {
              const [next, ...rest] = future;
              if (!next) return;
              setFuture(rest);
              setPast([...past, draft]);
              setDraft(next);
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">redo</span>
          </button>
        </div>
        <div className="lt-rhythm-more">
          <button type="button" className="is-primary" aria-expanded={saveOpen} onClick={() => setSaveOpen((open) => !open)}>
            {t("rhythm.editor.save")} ▾
          </button>
          {saveOpen ? (
            <div className="lt-rhythm-more__menu lt-loop-editor__save-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void save("library")}>
                {t("rhythm.editor.saveLibrary")}
              </button>
              {songRegionId ? (
                <button type="button" role="menuitem" onClick={() => void save("song")}>
                  {t("rhythm.editor.assignSong")}
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={() => void save("new")}>
                {t("rhythm.editor.saveNew")}
              </button>
            </div>
          ) : null}
        </div>
        <button type="button" className="lt-loop-editor__icon" aria-label={t("rhythm.close")} onClick={close}>
          <span className="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
      {settingsOpen ? <LoopPatternSettings pattern={draft} variation={variation} onChange={apply} /> : null}
      {pages > 1 ? (
        <div className="lt-loop-editor__pages" role="tablist" data-testid="loop-editor-pages">
          {Array.from({ length: pages }, (_, index) => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={index === currentPage}
              className={index === currentPage ? "lt-rhythm-chip is-active" : "lt-rhythm-chip"}
              onClick={() => setPage(index)}
            >
              {index + 1}
            </button>
          ))}
        </div>
      ) : null}
      <div className="lt-loop-editor__grid">
        <div className="lt-loop-editor__canvas">
        <LoopStepGrid
          pattern={draft}
          kit={kit}
          variation={variation}
          firstStep={currentPage * visible}
          visibleSteps={visible}
          onChange={apply}
        />
        </div>
      </div>
    </div>
    </div>
  );
}
