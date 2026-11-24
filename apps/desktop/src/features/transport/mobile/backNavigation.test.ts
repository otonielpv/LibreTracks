// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBackGuard, EXIT_HINT_MS, useBackDismissStore } from "./backNavigation";

/**
 * Paso 04 del plan de feedback de testers. `handleBack` es lo que MainActivity
 * pregunta en cada pulsación: `true` = la página la gastó, `false` = salir.
 */
function host() {
  const calls = { hint: [] as boolean[], playing: false };
  return {
    calls,
    port: {
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
  it("sin nada abierto y sin reproducción, deja salir", () => {
    const { port } = host();
    expect(createBackGuard(port).handleBack()).toBe(false);
  });

  it("cierra de uno en uno, el último primero, y luego deja salir", () => {
    // El caso que rompía el historial de mentira: tras cerrar el primero, la
    // entrada repuesta no nacía de un gesto y Chromium se la saltaba.
    const { port } = host();
    const guard = createBackGuard(port);
    const closePanel = open("panel");
    const closeFull = open("pantalla-completa");

    expect(guard.handleBack()).toBe(true);
    expect(closeFull).toHaveBeenCalledOnce();
    expect(closePanel).not.toHaveBeenCalled();

    expect(guard.handleBack()).toBe(true);
    expect(closePanel).toHaveBeenCalledOnce();

    expect(guard.handleBack()).toBe(false);
    expect(useBackDismissStore.getState().stack).toEqual([]);
  });

  it("con reproducción en curso, el primer atrás avisa y el segundo sale", () => {
    const { calls, port } = host();
    calls.playing = true;
    const guard = createBackGuard(port);

    expect(guard.handleBack()).toBe(true);
    expect(calls.hint).toEqual([true]);

    expect(guard.handleBack()).toBe(false);
    expect(calls.hint).toEqual([true, false]);
  });

  it("pasado el aviso vuelve a proteger la salida", () => {
    const { calls, port } = host();
    calls.playing = true;
    const guard = createBackGuard(port);

    guard.handleBack();
    vi.advanceTimersByTime(EXIT_HINT_MS);
    expect(calls.hint).toEqual([true, false]);

    expect(guard.handleBack()).toBe(true);
  });

  it("un overlay abierto se cierra aunque esté sonando, sin aviso", () => {
    const { calls, port } = host();
    calls.playing = true;
    const guard = createBackGuard(port);
    const close = open("modal");

    expect(guard.handleBack()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(calls.hint).not.toContain(true);
  });

  it("tras dispose no gasta nada", () => {
    const { port } = host();
    const guard = createBackGuard(port);
    open("modal");
    guard.dispose();
    expect(guard.handleBack()).toBe(false);
  });
});
