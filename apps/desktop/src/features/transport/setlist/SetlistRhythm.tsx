// El botón «Ritmo» de la barra superior y las pestañas de ritmo del Setlist
// son el mismo interruptor. En escritorio y tablet el panel vive en una
// pestaña de la consola: pulsar el botón la abre (y despliega la consola si
// estaba plegada) y volver a pulsarlo vuelve a Pistas; elegir la pestaña a
// mano ilumina el botón. En el teléfono no hay pestañas: el botón abre el
// panel acoplado bajo la vista y aquí no se hace nada.
import { useEffect, useRef } from "react";

import type { SongRegionSummary } from "@libretracks/shared/models";

import { RhythmDock } from "../rhythm/RhythmDock";
import { useRhythmStore } from "../rhythm/rhythmStore";
import { useSetlistStore, type SetlistBottomTab } from "./setlistStore";
import type { SetlistLayoutClass } from "./useSetlistLayout";

export function isRhythmTab(tab: SetlistBottomTab): boolean {
  return tab === "rhythm" || tab === "loops" || tab === "oneShots";
}

/** Sincroniza botón y pestañas; devuelve si el panel del teléfono está abierto. */
export function useSetlistRhythm(layout: SetlistLayoutClass): boolean {
  const open = useRhythmStore((s) => s.openByView.setlist);
  const onRhythmTab = useSetlistStore((s) => isRhythmTab(s.bottomTab));
  const seen = useRef<{ open: boolean; onRhythmTab: boolean } | null>(null);

  useEffect(() => {
    if (layout === "short") {
      seen.current = null;
      return;
    }
    const previous = seen.current;
    seen.current = { open, onRhythmTab };
    if (open === onRhythmTab) return;
    // Al entrar en la vista (o venir del teléfono) manda la pestaña: el
    // estado abierto persistido no debe saltar a Ritmo sin que nadie lo pida.
    if (!previous || previous.onRhythmTab !== onRhythmTab) {
      useRhythmStore.getState().setOpen("setlist", onRhythmTab);
      return;
    }
    const setlist = useSetlistStore.getState();
    if (open) {
      setlist.setBottomTab(layout === "wide" ? "rhythm" : "loops");
      setlist.setMixerCollapsed(false);
    } else {
      setlist.setBottomTab("tracks");
    }
  }, [layout, open, onRhythmTab]);
  return layout === "short" && open;
}

/** Teléfono: el panel acoplado bajo la vista, fuera de la consola (que allí
 * se turna con la onda y podía no estar a la vista al pulsar el botón). */
export function SetlistShortRhythmDock({ region }: { region: SongRegionSummary | null }) {
  return <RhythmDock view="setlist" layoutClass="short" songLoop={region?.loop ?? null} songRegionId={region?.id ?? null} />;
}
