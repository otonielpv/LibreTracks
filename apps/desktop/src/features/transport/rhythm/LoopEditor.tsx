// Editor de patrones a pantalla completa (plan drum-loops, paso 08):
// cabecera con nombre, variación A-D, ▶ escuchar (el motor, sin guardar),
// deshacer/rehacer local, Guardar ▾ y cerrar (pregunta si hay cambios).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DrumKit, LoopPattern } from "@libretracks/shared/models";

import { isMobileApp, previewLoopPattern, setLoopPlaying } from "../desktopApi";
import { LoopPatternSettings } from "./LoopPatternSettings";
import { VARIATION_LETTERS } from "./LoopRows";
import { LoopStepGrid } from "./LoopStepGrid";
import { normalizePattern, stepCount, stepsPerBar } from "./patternOps";
import type { RhythmLayoutClass } from "./useRhythmLayout";

export type LoopEditorSaveTarget = "library" | "song" | "new";

type LoopEditorProps = {
  pattern: LoopPattern;
  kit: DrumKit;
  layoutClass: RhythmLayoutClass;
  touch?: boolean;
  /** Región para «Asignar a esta canción»; sin ella la opción no aparece. */
  songRegionId?: string | null;
  onSave: (pattern: LoopPattern, target: LoopEditorSaveTarget) => Promise<void> | void;
  onClose: () => void;
  /** Confirmación al cerrar con cambios (inyectable en tests). */
  confirmDiscard?: () => boolean;
  newId?: () => string;
  /** Abre el editor del kit (solo kits de la biblioteca). */
  onEditKit?: () => void;
};

function visibleStepsFor(layout: RhythmLayoutClass, pattern: LoopPattern): number {
  const bar = stepsPerBar(pattern);
  return layout === "wide" ? bar * 2 : bar;
}

export function LoopEditor({
  pattern: initial,
  kit,
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
  const [draft, setDraft] = useState(() => normalizePattern(initial, kit));
  const [past, setPast] = useState<LoopPattern[]>([]);
  const [future, setFuture] = useState<LoopPattern[]>([]);
  const [variation, setVariation] = useState(0);
  const [page, setPage] = useState(0);
  const [listening, setListening] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saved, setSaved] = useState(draft);
  const dirty = draft !== saved;

  const visible = visibleStepsFor(layoutClass, draft);
  const pages = Math.max(1, Math.ceil(stepCount(draft) / visible));
  const currentPage = Math.min(page, pages - 1);

  const apply = (next: LoopPattern) => {
    if (next === draft) return;
    setPast((p) => [...p.slice(-49), draft]);
    setFuture([]);
    setDraft(next);
  };

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
            <span className="lt-loop-editor__kit-name">{kit.name}</span>
            {onEditKit ? (
              <button type="button" className="lt-loop-editor__link" onClick={onEditKit}>
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
      <LoopPatternSettings pattern={draft} variation={variation} onChange={apply} />
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
          shortLabels={layoutClass === "short"}
          onChange={apply}
        />
        </div>
      </div>
    </div>
  );
}
