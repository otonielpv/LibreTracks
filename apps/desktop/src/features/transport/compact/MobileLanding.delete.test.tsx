// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";

/**
 * Borrar una sesión desde la landing del móvil.
 *
 * En un teléfono no hay gestor de archivos con el que quitar una sesión: una
 * importada por error se quedaba ocupando el almacenamiento para siempre, y la
 * lista sólo sabía abrirlas. La papelera la borra de verdad — proyecto, audio y
 * caché — así que lo que se prueba aquí es que NUNCA lo hace sin confirmar.
 */

const listDefaultSessions = vi.fn();
const deleteSessionAt = vi.fn();
const confirmDialog = vi.fn();

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isAndroidApp: true,
  isMobileApp: true,
  listDefaultSessions: () => listDefaultSessions(),
  listSessionTemplates: () => Promise.resolve([]),
  deleteSessionAt: (songFile: string) => deleteSessionAt(songFile),
}));

vi.mock("../../../shared/dialog/dialogService", () => ({
  confirmDialog: (message: string) => confirmDialog(message),
}));

const { MobileLanding } = await import("./MobileLanding");

const CONCIERTO = {
  name: "Concierto",
  songFile: "/storage/emulated/0/songs/Concierto/Concierto.ltsession",
  modifiedMs: 2,
};
const ENSAYO = {
  name: "Ensayo",
  songFile: "/storage/emulated/0/songs/Ensayo/Ensayo.ltsession",
  modifiedMs: 1,
};

function renderLanding() {
  return render(
    <MobileLanding
      onCreateSession={vi.fn()}
      onCreateSessionFromTemplate={vi.fn()}
      onOpenSessionFromPath={vi.fn()}
    />,
  );
}

/** The trash button of the row whose open button is named `name`. */
function trashFor(name: string) {
  const row = screen.getByRole("button", { name }).closest("li");
  const trash = row?.querySelector<HTMLButtonElement>(
    ".lt-empty-state-recent-remove",
  );
  expect(trash, `no hay papelera en la fila de ${name}`).toBeTruthy();
  return trash!;
}

describe("MobileLanding / borrar una sesión", () => {
  beforeEach(() => {
    listDefaultSessions.mockReset();
    deleteSessionAt.mockReset();
    confirmDialog.mockReset();
    listDefaultSessions.mockResolvedValue([CONCIERTO, ENSAYO]);
    deleteSessionAt.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("no borra nada si la confirmación se cancela", async () => {
    confirmDialog.mockResolvedValue(false);
    renderLanding();
    await screen.findByRole("button", { name: CONCIERTO.name });

    fireEvent.click(trashFor(CONCIERTO.name));

    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    // El nombre de la sesión tiene que estar en el mensaje: es lo único que
    // distingue una sesión de otra en la lista.
    expect(confirmDialog.mock.calls[0][0]).toContain("Concierto");
    expect(deleteSessionAt).not.toHaveBeenCalled();
  });

  it("borra la sesión confirmada y refresca la lista", async () => {
    confirmDialog.mockResolvedValue(true);
    renderLanding();
    await screen.findByRole("button", { name: CONCIERTO.name });
    // La lista que se vuelve a pedir tras el borrado ya no la trae.
    listDefaultSessions.mockResolvedValue([ENSAYO]);

    fireEvent.click(trashFor(CONCIERTO.name));

    await waitFor(() =>
      expect(deleteSessionAt).toHaveBeenCalledWith(CONCIERTO.songFile),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: CONCIERTO.name })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: ENSAYO.name })).toBeTruthy();
  });

  it("deja la sesión en la lista y explica el fallo cuando el backend se niega", async () => {
    confirmDialog.mockResolvedValue(true);
    deleteSessionAt.mockRejectedValue(
      "Esa sesion esta abierta. Abre o crea otra sesion antes de borrarla.",
    );
    renderLanding();
    await screen.findByRole("button", { name: CONCIERTO.name });

    fireEvent.click(trashFor(CONCIERTO.name));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("abierta");
    // Sigue estando: borrar la fila de una sesión que no se borró la escondería
    // sin que dejara de ocupar el disco.
    expect(screen.getByRole("button", { name: CONCIERTO.name })).toBeTruthy();
  });
});
