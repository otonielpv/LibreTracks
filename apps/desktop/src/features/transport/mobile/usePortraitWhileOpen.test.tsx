// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Menús de escribir texto en vertical en el teléfono (plan
 * portrait-text-modals, paso 2).
 */

const setScreenOrientation = vi.fn<(mode: string) => Promise<void>>();
const platform = { isMobileApp: true, phone: true, landscape: true };
const orientationListeners = new Set<() => void>();

vi.mock("../desktopApi", () => ({
  get isMobileApp() {
    return platform.isMobileApp;
  },
  setScreenOrientation: (mode: string) => setScreenOrientation(mode),
}));

const { usePortraitWhileOpen, useFreeRotationWhile, resetPortraitWhileOpenForTests, ROTATE_BACK_TIMEOUT_MS } = await import(
  "./usePortraitWhileOpen"
);

function installMatchMedia() {
  window.matchMedia = ((query: string) => {
    const isOrientation = query.includes("orientation");
    return {
      get matches() {
        return isOrientation ? platform.landscape : platform.phone;
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => {
        if (isOrientation) orientationListeners.add(listener);
      },
      removeEventListener: (_: string, listener: () => void) => {
        orientationListeners.delete(listener);
      },
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

function Menu({ onClose, exposeClose }: { onClose?: () => void; exposeClose?: (close: () => void) => void }) {
  const close = usePortraitWhileOpen(onClose);
  exposeClose?.(close);
  return null;
}

const calls = () => setScreenOrientation.mock.calls.map(([mode]) => mode);

describe("usePortraitWhileOpen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPortraitWhileOpenForTests();
    orientationListeners.clear();
    platform.isMobileApp = true;
    platform.phone = true;
    platform.landscape = true;
    setScreenOrientation.mockResolvedValue(undefined);
    installMatchMedia();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("en un teléfono pide vertical al abrir y horizontal al cerrar", async () => {
    const view = render(<Menu />);
    expect(calls()).toEqual(["portrait"]);
    view.unmount();
    await waitFor(() => expect(calls()).toEqual(["portrait", "landscape"]));
  });

  it("en una tablet no llama a nada", async () => {
    platform.phone = false;
    const view = render(<Menu />);
    view.unmount();
    await Promise.resolve();
    expect(setScreenOrientation).not.toHaveBeenCalled();
  });

  it("en escritorio no llama a nada", async () => {
    platform.isMobileApp = false;
    const view = render(<Menu />);
    view.unmount();
    await Promise.resolve();
    expect(setScreenOrientation).not.toHaveBeenCalled();
  });

  it("con dos menús anidados vuelve a horizontal solo al cerrar el segundo", async () => {
    function Nested({ inner }: { inner: boolean }) {
      return (
        <>
          <Menu />
          {inner ? <Menu /> : null}
        </>
      );
    }
    const view = render(<Nested inner />);
    expect(calls()).toEqual(["portrait"]);
    view.rerender(<Nested inner={false} />);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls()).toEqual(["portrait"]);
    view.unmount();
    await waitFor(() => expect(calls()).toEqual(["portrait", "landscape"]));
  });

  it("un fallo del comando no lanza error", async () => {
    setScreenOrientation.mockRejectedValue(new Error("no hay Activity"));
    const view = render(<Menu />);
    view.unmount();
    await waitFor(() => expect(calls()).toEqual(["portrait", "landscape"]));
  });

  it("cerrar pide horizontal y espera al giro antes de quitar el menú", async () => {
    let close: () => void = () => {};
    const onClose = vi.fn();
    render(<Menu onClose={onClose} exposeClose={(next) => (close = next)} />);
    platform.landscape = false; // ya en vertical
    act(() => close());
    expect(calls()).toEqual(["portrait", "landscape"]);
    await Promise.resolve();
    expect(onClose).not.toHaveBeenCalled();
    platform.landscape = true;
    act(() => orientationListeners.forEach((listener) => listener()));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("si la pantalla no gira, cierra igualmente tras el tope", async () => {
    vi.useFakeTimers();
    let close: () => void = () => {};
    const onClose = vi.fn();
    const view = render(<Menu onClose={onClose} exposeClose={(next) => (close = next)} />);
    platform.landscape = false;
    act(() => close());
    await vi.advanceTimersByTimeAsync(ROTATE_BACK_TIMEOUT_MS + 10);
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    await vi.advanceTimersByTimeAsync(0);
    // El desmontaje no repite la petición: el cierre ya la hizo.
    expect(calls()).toEqual(["portrait", "landscape"]);
  });

  it("en una tablet cerrar llama a onClose sin pedir nada", () => {
    platform.phone = false;
    let close: () => void = () => {};
    const onClose = vi.fn();
    render(<Menu onClose={onClose} exposeClose={(next) => (close = next)} />);
    act(() => close());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(setScreenOrientation).not.toHaveBeenCalled();
  });

  it("con la letra a pantalla completa deja girar libre y vuelve a horizontal al plegarla", async () => {
    function Live({ expanded }: { expanded: boolean }) {
      useFreeRotationWhile(expanded);
      return null;
    }
    const view = render(<Live expanded={false} />);
    expect(setScreenOrientation).not.toHaveBeenCalled();
    view.rerender(<Live expanded />);
    expect(calls()).toEqual(["free"]);
    view.rerender(<Live expanded={false} />);
    await waitFor(() => expect(calls()).toEqual(["free", "landscape"]));
  });

  it("un menú abierto desde la letra expandida fuerza vertical y al cerrarse vuelve a libre", async () => {
    function Live({ menu }: { menu: boolean }) {
      useFreeRotationWhile(true);
      return menu ? <Menu /> : null;
    }
    const view = render(<Live menu={false} />);
    view.rerender(<Live menu />);
    view.rerender(<Live menu={false} />);
    await waitFor(() => expect(calls()).toEqual(["free", "portrait", "free"]));
  });

  it("en una tablet la letra expandida no pide nada", async () => {
    platform.phone = false;
    function Live() {
      useFreeRotationWhile(true);
      return null;
    }
    const view = render(<Live />);
    view.unmount();
    await Promise.resolve();
    expect(setScreenOrientation).not.toHaveBeenCalled();
  });
});
