// Puerta de fotogramas para los bucles de rAF permanentes del transporte.
//
// El timeline, el cabezal, la barra de desplazamiento y los hotspots siguen a
// refs que el camino caliente muta SIN avisar (a propósito, ver
// docs/REDESIGN_transport_refs_to_stores.md). Por eso cada uno corre un bucle
// de rAF que compara y sólo escribe si algo cambió. Con el transporte parado
// y nadie tocando nada, esos ~10 bucles siguen despertando al WebView en cada
// vsync: en un Oppo A5 con una sesión abierta y parada, la cadena de pintado
// se comía ~un núcleo entero (docs/internal/PLAY_CLOSED_TESTING_LOG.md, 22),
// y en una pantalla de 120 Hz el doble.
//
// La puerta deja correr los bucles mientras haya actividad y los aparca
// cuando lleva IDLE_AFTER_MS sin haberla. Es actividad:
//   - reproducir (nunca se aparca con el transporte en marcha);
//   - cualquier entrada del usuario (puntero, rueda, teclado, scroll, resize);
//   - cualquier cambio del store de transporte;
//   - un render de React de quien usa la puerta (useFrameGateWake), porque
//     las props llegan a los bucles por refs espejo;
//   - que un bucle haya escrito algo en este fotograma (markFrameActivity):
//     mientras algo se mueve —una animación, una caída, teselas que llegan—
//     la puerta sigue abierta.
// Así sólo se aparca cuando NINGÚN bucle ha tenido nada que hacer durante
// medio segundo, y cualquiera de esas señales los despierta a todos.

import { useLayoutEffect } from "react";
import { useTransportStore } from "./store";

const IDLE_AFTER_MS = 500;

const WAKE_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "touchstart",
  "touchmove",
  "touchend",
  "wheel",
  "keydown",
  "keyup",
  "resize",
  "scroll",
  "focus",
  "visibilitychange",
] as const;

let lastActivityMs = -Infinity;
let installed = false;
let parkedSeq = 0;
// Aparcados: id devuelto al llamante -> callback.
const parked = new Map<number, FrameRequestCallback>();
// Despertados: id del llamante -> id real de rAF, para que cancelar funcione
// aunque el llamante guarde el id que le dimos al aparcarlo.
const woken = new Map<number, number>();

function isPlaying() {
  return useTransportStore.getState().playback?.playbackState === "playing";
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  lastActivityMs = performance.now();
  const wake = () => markFrameActivity();
  for (const type of WAKE_EVENTS) {
    window.addEventListener(type, wake, { capture: true, passive: true });
  }
  useTransportStore.subscribe(wake);
}

/** Algo ha cambiado: mantener (o volver a poner) los bucles en marcha. */
export function markFrameActivity() {
  lastActivityMs = performance.now();
  if (parked.size === 0) return;
  const waking = [...parked];
  parked.clear();
  for (const [id, callback] of waking) {
    const realId = window.requestAnimationFrame((time) => {
      woken.delete(id);
      callback(time);
    });
    woken.set(id, realId);
  }
}

/** Como `requestAnimationFrame`, pero aparca el callback si no hay actividad. */
export function requestGatedFrame(callback: FrameRequestCallback): number {
  install();
  const idle =
    performance.now() - lastActivityMs > IDLE_AFTER_MS && !isPlaying();
  if (!idle) {
    return window.requestAnimationFrame(callback);
  }
  parkedSeq -= 1;
  parked.set(parkedSeq, callback);
  return parkedSeq;
}

export function cancelGatedFrame(id: number) {
  if (id >= 0) {
    window.cancelAnimationFrame(id);
    return;
  }
  parked.delete(id);
  const realId = woken.get(id);
  if (realId !== undefined) {
    window.cancelAnimationFrame(realId);
    woken.delete(id);
  }
}

/** Despierta la puerta en cada render: las props llegan a los bucles por refs. */
export function useFrameGateWake() {
  useLayoutEffect(() => {
    markFrameActivity();
  });
}

/** Sólo para tests. */
export function resetFrameGateForTests() {
  lastActivityMs = performance.now();
  parked.clear();
  woken.clear();
}
