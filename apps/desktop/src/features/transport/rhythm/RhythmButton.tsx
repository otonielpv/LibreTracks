// Botón «Ritmo» de las vistas (plan drum-loops, paso 07): abre o cierra el
// panel y se ilumina mientras suena un loop o un one shot, aunque el panel
// esté cerrado. El estado vivo llega por `audio:rhythm` aunque el panel no
// esté montado (`useRhythmMetersFeed`).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { listenToRhythmMeters } from "../desktopApi";
import { selectRhythmActive, useRhythmStore } from "./rhythmStore";
import "./rhythm.css";

/** Escucha `audio:rhythm` mientras el botón vive (una suscripción barata). */
export function useRhythmMetersFeed() {
  const applyMeters = useRhythmStore((s) => s.applyMeters);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    void listenToRhythmMeters(applyMeters).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [applyMeters]);
}

type RhythmButtonProps = {
  open: boolean;
  onToggle: () => void;
  className?: string;
  /** Sin texto (barras estrechas): solo el icono. */
  compact?: boolean;
};

export function RhythmButton({ open, onToggle, className, compact }: RhythmButtonProps) {
  const { t } = useTranslation();
  useRhythmMetersFeed();
  const active = useRhythmStore(selectRhythmActive);
  return (
    <button
      type="button"
      className={["lt-rhythm-button", active ? "is-active" : "", open ? "is-open" : "", className ?? ""]
        .join(" ")
        .trim()}
      aria-pressed={open}
      aria-label={t("rhythm.button")}
      title={t("rhythm.button")}
      data-testid="rhythm-button"
      data-active={active ? "true" : "false"}
      onClick={onToggle}
    >
      <span className="lt-rhythm-button__icon" aria-hidden="true">
        ◉
      </span>
      {compact ? null : <span className="lt-rhythm-button__label">{t("rhythm.button")}</span>}
    </button>
  );
}
