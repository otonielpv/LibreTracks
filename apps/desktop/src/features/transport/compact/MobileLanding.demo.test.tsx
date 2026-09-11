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
  // Se abre desde su propio boton y siempre es la misma sesion, asi que
  // apuntarla en "recientes" solo llena la lista de ruido. Antes, ademas,
  // dejaba una entrada NUEVA en cada pulsacion, porque se copiaba.
  it("se abre sin apuntarse en recientes", async () => {
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
        { remember: false },
      );
    });
  });
});
