import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";

import { isMobileApp } from "../desktopApi";
import type { TimelinePanState } from "../types";
import { DRAG_THRESHOLD_PX } from "../constants";
import { getElementScaleX } from "./timelineMath";
import { armTouchBackgroundTap } from "./touchBackgroundTap";

/**
 * Pulsación sobre el FONDO del timeline: el hueco vacío bajo las pistas y la
 * parte de un carril donde no hay clip.
 *
 * Escritorio y táctil se reparten esto de forma distinta, y esa es la razón de
 * que el bloque viva aquí y no en el panel:
 *
 * - Con ratón, pulsar salta ahí y arrastrar desplaza la cámara.
 * - Con el dedo, sólo queda el TOQUE. El recorrido vertical es del navegador
 *   (`touch-action: pan-y`) y el horizontal y el zoom son del gesto de dos
 *   dedos; dejar aquí un desplazamiento por eventos de ratón de compatibilidad
 *   hacía que ambos movieran la cámara a la vez. Ver ./touchBackgroundTap.
 */

export type TimelineBackgroundSeekDeps = {
  /** Fin del ESPACIO DE TRABAJO (canción + la cola vacía de una hora), no el
   * fin de la canción: pulsar más allá de la última región deja el cabezal
   * donde apunta el cursor en vez de devolverlo al final. */
  getSeekLimitSeconds: () => number;
  getCameraX: () => number;
  livePixelsPerSecondRef: MutableRefObject<number>;
  clientXToSeconds: (
    clientX: number,
    element: HTMLElement,
    cameraX: number,
    limitSeconds: number,
    pixelsPerSecond: number,
  ) => number;
  normalizeSeconds: (seconds: number, limitSeconds: number) => number;
  panRef: MutableRefObject<TimelinePanState>;
  closeContextMenu: () => void;
  previewSeek: (seconds: number) => void;
  restoreConfirmedTransportVisual: () => void;
  updateCameraX: (
    cameraX: number,
    options?: { commitToStore?: boolean },
  ) => unknown;
  commitSeek: (seconds: number) => void;
};

export function createTimelineBackgroundSeek(
  getDeps: () => TimelineBackgroundSeekDeps,
) {
  return function beginTimelineSeekOrPan(event: ReactMouseEvent<HTMLElement>) {
    const deps = getDeps();
    event.preventDefault();
    deps.closeContextMenu();

    const seekLimitSeconds = deps.getSeekLimitSeconds();
    const previewSeconds = deps.normalizeSeconds(
      deps.clientXToSeconds(
        event.clientX,
        event.currentTarget,
        deps.getCameraX(),
        seekLimitSeconds,
        deps.livePixelsPerSecondRef.current,
      ),
      seekLimitSeconds,
    );

    if (isMobileApp) {
      armTouchBackgroundTap({
        startClientX: event.clientX,
        startClientY: event.clientY,
        thresholdPx: DRAG_THRESHOLD_PX,
        onTap: () => deps.commitSeek(previewSeconds),
      });
      return;
    }

    deps.previewSeek(previewSeconds);

    const activePan: NonNullable<TimelinePanState> = {
      pointerId: 1,
      startClientX: event.clientX,
      pointerScaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      originCameraX: deps.getCameraX(),
      previewSeconds,
      hasMoved: false,
    };
    deps.panRef.current = activePan;

    const onMouseMove = (windowEvent: MouseEvent) => {
      const deltaX =
        (activePan.startClientX - windowEvent.clientX) /
        activePan.pointerScaleX;
      if (!activePan.hasMoved && Math.abs(deltaX) <= DRAG_THRESHOLD_PX) {
        return;
      }

      if (!activePan.hasMoved) {
        activePan.hasMoved = true;
        deps.restoreConfirmedTransportVisual();
      }

      deps.updateCameraX(activePan.originCameraX + deltaX, {
        commitToStore: false,
      });
    };

    const onMouseUp = (windowEvent: MouseEvent) => {
      if (windowEvent.button !== 0) {
        return;
      }

      deps.panRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      if (!activePan.hasMoved) {
        deps.commitSeek(activePan.previewSeconds);
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };
}
