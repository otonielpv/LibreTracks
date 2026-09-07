import { useEffect, useMemo, useState } from "react";
import type { TimelineMenus } from "../menus/timelineMenus";
import type {
  MobileCreationHandlers,
  MobileSelectionMenus,
} from "./selectionActions";

type UseMobileSelectionBarArgs = {
  timelineMenus: TimelineMenus;
  /** Segundos del cabezal, por getter: la marca nace donde se ve el cabezal. */
  getPlayheadSeconds: () => number;
  /** El MISMO dialogo de importacion que la biblioteca. */
  onAddAudios: () => void;
};

/**
 * Lo que `MobileSelectionActionBar` necesita del panel, sin que el panel tenga
 * que saber como se arma.
 *
 * El unico truco esta en la puerta de disponibilidad. Las factories de menus
 * leen sus dependencias de un ref que el panel rellena EN UN EFECTO, y los
 * efectos de los hijos corren antes que los del padre: sin esta puerta, la
 * barra llamaria a una factory sin dependencias en su primer render y
 * reventaria. Cuesta un render extra, solo al montar, y a cambio la barra no
 * necesita saber nada de ese orden.
 */
export function useMobileSelectionBar({
  timelineMenus,
  getPlayheadSeconds,
  onAddAudios,
}: UseMobileSelectionBarArgs): {
  menus: MobileSelectionMenus | null;
  creation: MobileCreationHandlers;
} {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);

  const menus = useMemo<MobileSelectionMenus | null>(
    () =>
      ready
        ? {
            clipContextMenu: timelineMenus.clipContextMenu,
            sectionContextMenu: timelineMenus.sectionContextMenu,
            tempoMarkerContextMenu: timelineMenus.tempoMarkerContextMenu,
            timeSignatureMarkerContextMenu:
              timelineMenus.timeSignatureMarkerContextMenu,
            songRegionContextMenu: timelineMenus.songRegionContextMenu,
            trackContextMenu: timelineMenus.trackContextMenu,
          }
        : null,
    [ready, timelineMenus],
  );

  const creation = useMemo<MobileCreationHandlers>(
    () => ({
      onCreateMarker: () =>
        timelineMenus.openCreateMarkerKindMenu(getPlayheadSeconds()),
      onAddAudios,
    }),
    [timelineMenus, getPlayheadSeconds, onAddAudios],
  );

  return { menus, creation };
}
