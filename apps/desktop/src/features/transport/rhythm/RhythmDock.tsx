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
import { RhythmEditors } from "./RhythmEditors";
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
    })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return [settings, setSettings];
}

/** Acoplado abajo en todas las clases (en el teléfono, más bajo y dejando
 * el transporte a la vista); en el Setlist de escritorio y tablet, pestaña.
 * Nunca a pantalla completa: tapaba la app y no se podía seguir tocando. */
export function rhythmVariantFor(view: RhythmView, layout: RhythmLayoutClass | undefined): RhythmPanelVariant {
  if (view === "setlist" && layout !== "short") return "tab";
  return "docked";
}

function currentWindowLayout(): RhythmLayoutClass {
  if (typeof window === "undefined") return "wide";
  return classifySetlistLayout(window.innerWidth, window.innerHeight);
}

/** Clase de tamaño de la VENTANA. El panel acoplado mide 300 px de alto: si
 * se midiera a sí mismo caería siempre en `short` (teléfono). */
function useWindowLayout(): RhythmLayoutClass {
  const [layout, setLayout] = useState(currentWindowLayout);
  useEffect(() => {
    const onResize = () => setLayout(currentWindowLayout());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return layout;
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
  /** Región de la canción para «Asignar a esta canción». */
  songRegionId?: string | null;
};

export function RhythmDock({ view, layoutClass, surfaces, alwaysOpen, songLoop, songRegionId }: RhythmDockProps) {
  const [editing, setEditing] = useState<RhythmEditTarget | null>(null);
  const open = useRhythmStore((s) => s.openByView[view]);
  const setOpen = useRhythmStore((s) => s.setOpen);
  const [settings, setSettings] = useRhythmSettings();
  const expandedInStore = useRhythmStore((s) => s.expanded);
  const setExpanded = useRhythmStore((s) => s.setExpanded);
  const collapse = useCallback(() => setExpanded(false), [setExpanded]);
  const close = useCallback(() => {
    setExpanded(false);
    setOpen(view, false);
  }, [setExpanded, setOpen, view]);
  const windowLayout = useWindowLayout();
  const layout = layoutClass ?? windowLayout;
  const variant = rhythmVariantFor(view, layout);
  // Solo el panel acoplado se amplía: la pestaña del Setlist ya ocupa su sitio.
  const canExpand = variant === "docked";
  const expanded = canExpand && expandedInStore;

  if (!(alwaysOpen || open) || !settings) return null;
  return (
    <>
      {layout === "short" && !alwaysOpen ? <DismissOnBack close={close} /> : null}
      {/* Después del de cerrar: atrás sale primero de la pantalla completa. */}
      {expanded ? <DismissOnBack close={collapse} /> : null}
      <RhythmPanel
        variant={variant}
        settings={settings}
        onSettings={setSettings}
        layoutClass={layout}
        surfaces={surfaces}
        songLoop={songLoop}
        onEdit={setEditing}
        onClose={alwaysOpen ? undefined : close}
        expanded={expanded}
        onToggleExpanded={canExpand ? () => setExpanded(!expanded) : undefined}
      />
      <RhythmEditors
        target={editing}
        settings={settings}
        onSettings={setSettings}
        songLoop={songLoop}
        songRegionId={songRegionId}
        layoutClass={layout}
        onClose={() => setEditing(null)}
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
