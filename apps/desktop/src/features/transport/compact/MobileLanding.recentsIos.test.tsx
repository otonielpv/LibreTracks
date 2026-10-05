// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";

/**
 * En iOS la papelera de recientes sólo quita la entrada, como en escritorio:
 * las sesiones están en Archivos, y borrarlas es cosa del usuario desde ahí.
 * Borrar el proyecto entero desde la lista de recientes sólo pasa en Android,
 * donde las sesiones viven en carpetas de la app que nadie más alcanza.
 */

const deleteSessionAt = vi.fn();
const confirmDialog = vi.fn();

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isAndroidApp: false,
  isIOSApp: true,
  isMobileApp: true,
  listSessionTemplates: () => Promise.resolve([]),
  deleteSessionAt: (songFile: string) => deleteSessionAt(songFile),
}));

vi.mock("../../../shared/dialog/dialogService", () => ({
  confirmDialog: (message: string) => confirmDialog(message),
}));

const { MobileLanding } = await import("./MobileLanding");
const { clearRecentSessions, loadRecentSessions, pushRecentSession } = await import(
  "../recentSessions"
);

const DOMINGO = "/var/mobile/Containers/Data/Application/X/Documents/Domingo/Domingo.ltsession";

describe("MobileLanding / recientes en iOS", () => {
  beforeEach(() => {
    deleteSessionAt.mockReset();
    confirmDialog.mockReset();
    clearRecentSessions();
    pushRecentSession(DOMINGO);
  });

  afterEach(() => {
    cleanup();
    clearRecentSessions();
  });

  it("la papelera sólo quita la sesión de recientes, sin borrarla", async () => {
    render(
      <MobileLanding
        onCreateSession={vi.fn()}
        onCreateSessionFromTemplate={vi.fn()}
        onOpenSessionFromPath={vi.fn()}
      />,
    );
    const row = (await screen.findByRole("button", { name: "Domingo" })).closest("li");
    const trash = row?.querySelector<HTMLButtonElement>(".lt-empty-state-recent-remove");
    expect(trash).toBeTruthy();

    fireEvent.click(trash!);

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(deleteSessionAt).not.toHaveBeenCalled();
    expect(loadRecentSessions()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Domingo" })).toBeNull();
  });
});
