import {
  SONG_KEY_OPTIONS,
  type KeyChangeSummary,
  type SongRegionSummary,
  type SongView,
  type TransportSnapshot,
} from "@libretracks/shared/models";

import { clientToZoomedCoords } from "../../../shared/uiZoom";
import { setSongRegionKeyChanges, type KeyChangeInput } from "../desktopApi";
import { formatClock } from "../helpers";
import type { ContextMenuAction, ContextMenuState } from "../types";

export type KeyChangeMenuDeps = {
  t: (key: string, options?: Record<string, unknown>) => string;
  runAction: (work: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
  contextMenuPositionRef: { current: { x: number; y: number } };
};

/** Margen para no crear un cambio pegado al inicio o al final de la canción. */
const EDGE_SECONDS = 0.01;

function asInputs(changes: KeyChangeSummary[]): KeyChangeInput[] {
  return changes.map(({ id, startSeconds, key }) => ({ id, startSeconds, key }));
}

/** Guarda la lista entera de cambios de la canción (un paso de deshacer). */
export async function commitKeyChanges(
  region: SongRegionSummary,
  changes: KeyChangeInput[],
  status: string,
  deps: Pick<KeyChangeMenuDeps, "runAction" | "applyPlaybackSnapshot" | "setStatus">,
) {
  await deps.runAction(async () => {
    const snapshot = await setSongRegionKeyChanges(region.id, changes);
    deps.applyPlaybackSnapshot(snapshot);
    deps.setStatus(status);
  });
}

/** Las 24 notas como menú en `position`; `current` lleva la marca de elegida. */
function openKeyPicker(
  position: { x: number; y: number },
  title: string,
  current: string | null,
  extra: ContextMenuAction[],
  onKey: (key: string) => Promise<void>,
  deps: KeyChangeMenuDeps,
) {
  deps.contextMenuPositionRef.current = position;
  deps.setContextMenu({
    ...position,
    title,
    actions: [
      ...extra,
      ...SONG_KEY_OPTIONS.map((key) => ({
        label: key,
        swatch: current === key ? "#C9A7FF" : undefined,
        onSelect: () => onKey(key),
      })),
    ],
  });
}

/**
 * "Cambio de nota en el cursor ▸" del menú de la canción: elige la nota que
 * empieza a regir donde está el cursor. Como "Partir canción en el cursor",
 * el cursor tiene que estar dentro de la canción.
 */
export function keyChangeAtCursorAction(
  region: SongRegionSummary,
  cursorSeconds: number,
  deps: KeyChangeMenuDeps,
): ContextMenuAction {
  const { t } = deps;
  const inside =
    cursorSeconds > region.startSeconds + EDGE_SECONDS &&
    cursorSeconds < region.endSeconds - EDGE_SECONDS;
  return {
    label: `${t("transport.keyChanges.addAtCursor")} ▸`,
    disabled: !inside,
    // Submenú: se abre un poco desplazado del menú del que sale.
    onSelect: () =>
      openKeyPicker(
        {
          x: deps.contextMenuPositionRef.current.x + 12,
          y: deps.contextMenuPositionRef.current.y + 12,
        },
        t("transport.keyChanges.addAtCursorTitle", { time: formatClock(cursorSeconds) }),
        null,
        [],
        (key) =>
          commitKeyChanges(
            region,
            [
              ...asInputs(region.keyChanges ?? []),
              { startSeconds: cursorSeconds, key },
            ],
            t("transport.keyChanges.added", { key, time: formatClock(cursorSeconds) }),
            deps,
          ),
        deps,
      ),
  };
}

/** Menú de una muesca de cambio de nota en `position`: otra nota, o quitarla. */
export function openKeyChangeMenu(
  region: SongRegionSummary,
  changeId: string,
  position: { x: number; y: number },
  deps: KeyChangeMenuDeps,
) {
  const { t } = deps;
  const changes = region.keyChanges ?? [];
  const change = changes.find((candidate) => candidate.id === changeId);
  if (!change) return;
  const time = formatClock(change.startSeconds);
  openKeyPicker(
    position,
    t("transport.keyChanges.menuTitle", { time }),
    change.key,
    [
      {
        label: t("transport.keyChanges.remove"),
        onSelect: () =>
          commitKeyChanges(
            region,
            asInputs(changes.filter((candidate) => candidate.id !== changeId)),
            t("transport.keyChanges.removed", { time }),
            deps,
          ),
      },
    ],
    (key) =>
      commitKeyChanges(
        region,
        asInputs(
          changes.map((candidate) =>
            candidate.id === changeId ? { ...candidate, key } : candidate,
          ),
        ),
        t("transport.keyChanges.updated", { key, time }),
        deps,
      ),
    deps,
  );
}

/** Mueve un cambio de nota a `startSeconds` (arrastrar su muesca). Con `copy`
 * (Alt/Option al soltar) añade otro con la misma nota ahí y deja el original. */
export function moveKeyChange(
  region: SongRegionSummary,
  changeId: string,
  startSeconds: number,
  deps: Pick<KeyChangeMenuDeps, "t" | "runAction" | "applyPlaybackSnapshot" | "setStatus">,
  copy = false,
) {
  const clamped = Math.min(
    region.endSeconds - EDGE_SECONDS,
    Math.max(region.startSeconds + EDGE_SECONDS, startSeconds),
  );
  const changes = region.keyChanges ?? [];
  if (copy) {
    const source = changes.find((candidate) => candidate.id === changeId);
    if (!source) return Promise.resolve();
    return commitKeyChanges(
      region,
      [...asInputs(changes), { startSeconds: clamped, key: source.key }],
      deps.t("transport.keyChanges.added", { key: source.key, time: formatClock(clamped) }),
      deps,
    );
  }
  return commitKeyChanges(
    region,
    asInputs(
      (region.keyChanges ?? []).map((candidate) =>
        candidate.id === changeId ? { ...candidate, startSeconds: clamped } : candidate,
      ),
    ),
    deps.t("transport.keyChanges.moved", { time: formatClock(clamped) }),
    deps,
  );
}

export type KeyChangeCallbacks = {
  /** Toque, clic o clic derecho en una muesca (coordenadas de cliente). */
  openMenu: (clientX: number, clientY: number, regionId: string, changeId: string) => void;
  /** Suelta un arrastre de muesca en `startSeconds` (segundos de vista);
   * `copy` si Alt/Option estaba pulsado al soltar. */
  move: (regionId: string, changeId: string, startSeconds: number, copy?: boolean) => void;
};

/** Lo que reciben las zonas táctiles de las muescas, instanciado una vez. */
export function createKeyChangeCallbacks(
  getDeps: () => KeyChangeMenuDeps & { songRef: { current: SongView | null } },
): KeyChangeCallbacks {
  const regionById = (regionId: string) =>
    getDeps().songRef.current?.regions.find((region) => region.id === regionId);
  return {
    openMenu: (clientX, clientY, regionId, changeId) => {
      const region = regionById(regionId);
      if (region) {
        openKeyChangeMenu(region, changeId, clientToZoomedCoords(clientX, clientY), getDeps());
      }
    },
    move: (regionId, changeId, startSeconds, copy) => {
      const region = regionById(regionId);
      if (region) void moveKeyChange(region, changeId, startSeconds, getDeps(), copy);
    },
  };
}
