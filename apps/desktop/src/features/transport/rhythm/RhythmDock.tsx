// El panel Ritmo montado en una vista (plan drum-loops, paso 07). Autónomo
// para que las vistas (y el monolito) solo lo monten:
//   - lee los ajustes él mismo (`getSettings` + `settings:updated`, que el
//     backend emite al cambiar los de ritmo);
//   - abierto/cerrado por vista en `rhythmStore`;
//   - acoplado en escritorio y tablet, hoja a pantalla completa en un
//     teléfono horizontal (`short`), que se cierra con atrás en Android.
import { useCallback, useEffect, useState } from "react";

import type { AppSettings, RegionLoop } from "@libretracks/shared/models";

import { getSettings, listenToSettingsUpdated } from "../desktopApi";
import { DismissOnBack } from "../mobile/DismissOnBack";
import { classifySetlistLayout } from "../setlist/useSetlistLayout";
import { RhythmButton } from "./RhythmButton";
import { RhythmPanel, type RhythmEditTarget, type RhythmPanelSurfaces, type RhythmPanelVariant } from "./RhythmPanel";
import { useRhythmStore, type RhythmView } from "./rhythmStore";
import type { RhythmLayoutClass } from "./useRhythmLayout";

/** Ajustes de la app vistos desde el panel, sin depender de la vista. */
export function useRhythmSettings(): [AppSettings | null, (settings: AppSettings) => void] {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    let alive = true;
    void getSettings()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch(() => {});
    let unlisten: (() => void) | null = null;
    void listenToSettingsUpdated((s) => {
      if (alive) setSettings(s);
    }).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return [settings, setSettings];
}

/** Hoja en teléfono horizontal; si no, acoplado. */
export function rhythmVariantFor(view: RhythmView, layout: RhythmLayoutClass | undefined): RhythmPanelVariant {
  if (view === "setlist") return layout === "short" ? "sheet" : "tab";
  return layout === "short" ? "sheet" : "docked";
}

function currentWindowLayout(): RhythmLayoutClass {
  if (typeof window === "undefined") return "wide";
  return classifySetlistLayout(window.innerWidth, window.innerHeight);
}

type RhythmDockProps = {
  view: RhythmView;
  /** Fuerza la clase de tamaño (tests y arnés). */
  layoutClass?: RhythmLayoutClass;
  /** El Setlist separa Loops y One shots en dos pestañas fuera de `wide`. */
  surfaces?: RhythmPanelSurfaces;
  /** Siempre visible (pestaña del Setlist) en vez de seguir el botón. */
  alwaysOpen?: boolean;
  songLoop?: RegionLoop | null;
  onEdit?: (target: RhythmEditTarget) => void;
};

export function RhythmDock({ view, layoutClass, surfaces, alwaysOpen, songLoop, onEdit }: RhythmDockProps) {
  const open = useRhythmStore((s) => s.openByView[view]);
  const setOpen = useRhythmStore((s) => s.setOpen);
  const [settings, setSettings] = useRhythmSettings();
  const close = useCallback(() => setOpen(view, false), [setOpen, view]);
  const layout = layoutClass ?? currentWindowLayout();
  const variant = rhythmVariantFor(view, layout);

  if (!(alwaysOpen || open) || !settings) return null;
  return (
    <>
      {variant === "sheet" && !alwaysOpen ? <DismissOnBack close={close} /> : null}
      <RhythmPanel
        variant={variant}
        settings={settings}
        onSettings={setSettings}
        layoutClass={layoutClass}
        surfaces={surfaces}
        songLoop={songLoop}
        onEdit={onEdit}
        onClose={alwaysOpen ? undefined : close}
      />
    </>
  );
}

/** El botón «Ritmo» de una vista, enlazado a su estado abierto. */
export function RhythmViewButton({ view, compact, className }: { view: RhythmView; compact?: boolean; className?: string }) {
  const open = useRhythmStore((s) => s.openByView[view]);
  const toggleOpen = useRhythmStore((s) => s.toggleOpen);
  return <RhythmButton open={open} onToggle={() => toggleOpen(view)} compact={compact} className={className} />;
}
