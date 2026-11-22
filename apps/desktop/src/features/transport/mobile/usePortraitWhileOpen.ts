import { useCallback, useEffect, useRef, useState } from "react";

import { setScreenOrientation } from "../desktopApi";
import { isPhoneScreenNow } from "./phoneScreen";

/**
 * Orientación del teléfono (plan `docs/plans/portrait-text-modals`). La app
 * va en horizontal salvo:
 *
 * - **Menús de escribir texto** (`usePortraitWhileOpen`): vertical forzada
 *   mientras estén abiertos. Escribir con el móvil tumbado es incómodo.
 * - **Letra y acordes a pantalla completa** (`useFreeRotationWhile`): el móvil
 *   gira con el sensor; se puede leer en vertical, pero no se fuerza.
 *
 * Un gestor único decide qué pedir (vertical > libre > horizontal) con
 * contadores globales, así los menús anidados (Letra en proyección abre el
 * editor de diapositivas) o un menú abierto desde la letra expandida vuelven
 * al modo correcto al cerrarse. Solo pide al backend cuando el modo cambia.
 *
 * Tablets y escritorio no giran. «Teléfono» se decide UNA vez al montar: ya en
 * vertical el ancho cambia y la consulta de teléfono podría cambiar de
 * opinión. Si el comando falla, todo sigue en horizontal y nada se rompe.
 */

type Mode = "portrait" | "free" | "landscape";

/** Tope de espera al giro antes de cerrar igualmente. */
export const ROTATE_BACK_TIMEOUT_MS = 450;

let portraitCount = 0;
/** Menús vertical que ya están cerrándose: no cuentan para el modo. */
let closingCount = 0;
let freeCount = 0;
let current: Mode = "landscape";

function desired(): Mode {
  if (portraitCount - closingCount > 0) return "portrait";
  if (freeCount > 0) return "free";
  return "landscape";
}

function sync() {
  const next = desired();
  if (next === current) return;
  current = next;
  try {
    void setScreenOrientation(next).catch(() => {});
  } catch {
    // Sin backend (tests, navegador): todo sigue como esté.
  }
}

/** En diferido: StrictMode desmonta y vuelve a montar en el mismo commit, y
 * no queremos un giro de ida y vuelta por eso. */
function syncSoon() {
  queueMicrotask(sync);
}

function waitForLandscape(): Promise<void> {
  return new Promise((resolve) => {
    const query = typeof window !== "undefined" ? window.matchMedia?.("(orientation: landscape)") : undefined;
    if (!query || query.matches) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      query.removeEventListener?.("change", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (query.matches) finish();
    };
    query.addEventListener?.("change", onChange);
    const timer = setTimeout(finish, ROTATE_BACK_TIMEOUT_MS);
  });
}

/**
 * Vertical mientras el menú esté montado. Devuelve `close` envuelto (estable,
 * apto para `useDismissOnBack`): primero devuelve la pantalla a su modo
 * anterior, espera al giro (o un tope corto) y entonces cierra, para que no se
 * vea la DAW de detrás recolocándose en vertical.
 */
export function usePortraitWhileOpen(close?: () => void): () => void {
  const [phone] = useState(isPhoneScreenNow);
  const closeRef = useRef(close);
  closeRef.current = close;
  const closing = useRef(false);

  useEffect(() => {
    if (!phone) return;
    portraitCount += 1;
    sync();
    return () => {
      portraitCount -= 1;
      if (closing.current) {
        closing.current = false;
        closingCount -= 1;
      }
      syncSoon();
    };
  }, [phone]);

  return useCallback(() => {
    const run = () => closeRef.current?.();
    if (!phone || portraitCount === 0) {
      run();
      return;
    }
    if (closing.current) return;
    closing.current = true;
    closingCount += 1;
    sync();
    const wait = current === "landscape" ? waitForLandscape() : Promise.resolve();
    void wait.then(run);
  }, [phone]);
}

/** El móvil gira con el sensor mientras `active` (letra a pantalla completa). */
export function useFreeRotationWhile(active: boolean) {
  const [phone] = useState(isPhoneScreenNow);
  useEffect(() => {
    if (!phone || !active) return;
    freeCount += 1;
    sync();
    return () => {
      freeCount -= 1;
      syncSoon();
    };
  }, [phone, active]);
}

/** Solo para tests: vuelve al estado de arranque. */
export function resetPortraitWhileOpenForTests() {
  portraitCount = 0;
  closingCount = 0;
  freeCount = 0;
  current = "landscape";
}
