// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Paso 03 del plan de feedback de testers: la canción de demostración no
 * ensucia «Recientes».
 *
 * Se excluye **al registrar**, no al pintar. Por eso el test es de
 * `rememberRecentSession` y no de la pantalla: si el filtro estuviera en quien
 * pinta la lista, la entrada seguiría ahí ocupando un hueco y reaparecería por
 * cualquier otro camino que lea los recientes.
 *
 * Quién es la demo lo decide el backend (una marca dentro de su carpeta, que
 * aguanta un renombrado); aquí se simula esa respuesta.
 */
const isDemoSession = vi.fn<(path: string) => Promise<boolean>>();

vi.mock("./desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./desktopApi")>()),
  isDemoSession: (path: string) => isDemoSession(path),
}));

const { loadRecentSessions, pushRecentSession, rememberRecentSession } =
  await import("./recentSessions");

const DEMO = "/data/songs/Cancion de demostracion/Cancion de demostracion.ltsession";
const SHOW = "/data/songs/Domingo/Domingo.ltsession";

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  isDemoSession.mockImplementation((path) => Promise.resolve(path === DEMO));
});

describe("registro de recientes", () => {
  it("apunta una sesion normal", async () => {
    await rememberRecentSession(SHOW);

    expect(loadRecentSessions().map((entry) => entry.path)).toEqual([SHOW]);
  });

  it("no apunta la cancion de demostracion", async () => {
    await rememberRecentSession(DEMO);

    expect(loadRecentSessions()).toEqual([]);
  });

  it("borra la entrada que dejaron las versiones anteriores", async () => {
    // Quien ya tenia la demo en su lista: la primera vez que la vuelva a
    // abrir, la entrada se va.
    pushRecentSession(DEMO);
    pushRecentSession(SHOW);
    expect(loadRecentSessions()).toHaveLength(2);

    await rememberRecentSession(DEMO);

    expect(loadRecentSessions().map((entry) => entry.path)).toEqual([SHOW]);
  });

  it("no apunta nada con una ruta vacia, y no pregunta al backend", async () => {
    await rememberRecentSession("");

    expect(isDemoSession).not.toHaveBeenCalled();
    expect(loadRecentSessions()).toEqual([]);
  });
});
