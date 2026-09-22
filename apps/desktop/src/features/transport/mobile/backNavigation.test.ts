// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBackGuard,
  EXIT_HINT_MS,
  useBackDismissStore,
} from "./backNavigation";

/**
 * Paso 04 del plan de feedback de testers.
 *
 * La máquina de estados se prueba contra un historial de mentira a propósito:
 * lo que importa es CUÁNTAS entradas hay puestas y qué se cierra con cada
 * pulsación, no cómo implementa jsdom `history.back()` (que es asíncrono y
 * complicaría el test sin probar nada más).
 */
function host() {
  const calls = {
    pushed: 0,
    popped: 0,
    hint: [] as boolean[],
    playing: false,
  };
  return {
    calls,
    port: {
      pushEntry: () => {
        calls.pushed += 1;
      },
      popEntry: () => {
        calls.popped += 1;
      },
      isPlaying: () => calls.playing,
      setExitHintVisible: (visible: boolean) => {
        calls.hint.push(visible);
      },
    },
  };
}

function open(id: string) {
  const close = vi.fn();
  useBackDismissStore.getState().register({ id, close });
  return close;
}

beforeEach(() => {
  useBackDismissStore.setState({ stack: [] });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("guardián del botón atrás", () => {
  it("no pone ninguna entrada de historial si no hay nada abierto ni sonando", () => {
    const { calls, port } = host();
    const guard = createBackGuard(port);

    guard.sync();

    expect(calls.pushed).toBe(0);
    expect(guard.isArmed()).toBe(false);
  });

  it("cierra lo abierto en vez de salir, y vuelve a armarse si queda algo", () => {
    const { calls, port } = host();
    const guard = createBackGuard(port);

    const closePanel = open("panel");
    guard.sync();
    const closeModal = open("modal");
    guard.sync();

    // Una sola entrada de historial, no una por overlay: se repone tras cada
    // pulsación mientras quede algo abierto.
    expect(calls.pushed).toBe(1);

    guard.handleBack();
    expect(closeModal).toHaveBeenCalledOnce();
    expect(closePanel).not.toHaveBeenCalled();
    expect(calls.pushed).toBe(2);

    guard.handleBack();
    expect(closePanel).toHaveBeenCalledOnce();
    // Ya no queda nada: no se repone, así que el siguiente atrás sale.
    expect(calls.pushed).toBe(2);
    expect(guard.isArmed()).toBe(false);
  });

  it("cierra el último que se abrió, no el primero", () => {
    const { port } = host();
    const guard = createBackGuard(port);

    const first = open("a");
    const second = open("b");
    guard.sync();

    guard.handleBack();

    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("sin nada abierto y sin reproducción, deja salir", () => {
    const { calls, port } = host();
    const guard = createBackGuard(port);

    guard.sync();
    guard.handleBack();

    expect(calls.pushed).toBe(0);
    expect(calls.hint).toEqual([false]);
  });

  it("con reproducción en curso, el primer atrás avisa y no sale", () => {
    const { calls, port } = host();
    calls.playing = true;
    const guard = createBackGuard(port);

    guard.sync();
    expect(calls.pushed).toBe(1);

    guard.handleBack();

    // Avisa y NO se rearma: el segundo toque cae en el atrás de siempre.
    expect(calls.hint).toEqual([false, true]);
    expect(guard.isArmed()).toBe(false);

    // Pasado el aviso vuelve a proteger, por si el toque accidental llega
    // cinco minutos después.
    vi.advanceTimersByTime(EXIT_HINT_MS);
    expect(calls.hint).toEqual([false, true, false]);
    expect(calls.pushed).toBe(2);
  });

  it("quita la entrada cuando se cierra todo por otro camino", () => {
    const { calls, port } = host();
    const guard = createBackGuard(port);

    open("modal");
    guard.sync();
    expect(calls.pushed).toBe(1);

    // El usuario lo cierra con su propia X.
    useBackDismissStore.getState().unregister("modal");
    guard.sync();

    expect(calls.popped).toBe(1);
    expect(guard.isArmed()).toBe(false);
  });

  it("aguanta cerrar un modal y abrir otro antes de que llegue el eco", () => {
    // La carrera real: `history.back()` es asíncrono, así que su `popstate`
    // puede llegar DESPUÉS de que otro modal haya puesto su entrada. Si ese
    // eco se tomara por una pulsación del usuario, cerraría el modal nuevo.
    const { calls, port } = host();
    const guard = createBackGuard(port);

    open("primero");
    guard.sync();
    useBackDismissStore.getState().unregister("primero");
    guard.sync(); // pide quitar la entrada; el eco aún no ha llegado

    const closeSecond = open("segundo");
    guard.sync();

    // Ahora llega el eco del `history.back()` del primero.
    guard.handleBack();

    expect(closeSecond).not.toHaveBeenCalled();
    // Y quedamos protegidos otra vez para el modal que sigue abierto.
    expect(guard.isArmed()).toBe(true);
  });

  it("un atrás real tras esa carrera sí cierra el modal que queda", () => {
    const { port } = host();
    const guard = createBackGuard(port);

    open("primero");
    guard.sync();
    useBackDismissStore.getState().unregister("primero");
    guard.sync();
    const closeSecond = open("segundo");
    guard.sync();
    guard.handleBack(); // eco

    guard.handleBack(); // pulsación de verdad

    expect(closeSecond).toHaveBeenCalledOnce();
  });
});
