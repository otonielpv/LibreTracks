// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";

const openDemoSession = vi.fn();

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isAndroidApp: true,
  isMobileApp: true,
  listDefaultSessions: () => Promise.resolve([]),
  listSessionTemplates: () => Promise.resolve([]),
  openDemoSession: () => openDemoSession(),
}));

const { MobileLanding } = await import("./MobileLanding");

beforeEach(async () => {
  vi.clearAllMocks();
  openDemoSession.mockResolvedValue("/songs/Demo/Demo.ltsession");
  await (await import("../../../shared/i18n")).default.changeLanguage("es");
});
afterEach(cleanup);

describe("la cancion de demostracion", () => {
  // Se abre por el MISMO camino que cualquier otra sesion listada: el boton no
  // lleva ninguna excepcion. Que no acabe en "recientes" lo decide
  // `rememberRecentSession` reconociendo la demo, venga del boton, de la lista
  // de sesiones o de "Abrir" — ver recentSessions.demo.test.ts.
  it("se abre por el mismo camino que las demas sesiones", async () => {
    const onOpenSessionFromPath = vi.fn();
    render(
      <MobileLanding
        onCreateSession={vi.fn()}
        onCreateSessionFromTemplate={vi.fn()}
        onOpenSessionFromPath={onOpenSessionFromPath}
      />,
    );

    screen.getByRole("button", { name: /demostraci/i }).click();

    await waitFor(() => {
      expect(onOpenSessionFromPath).toHaveBeenCalledWith(
        "/songs/Demo/Demo.ltsession",
      );
    });
  });
});
