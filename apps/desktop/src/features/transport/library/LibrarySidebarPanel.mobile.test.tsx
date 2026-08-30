// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: true,
}));

const { LibrarySidebarPanel } = await import("./LibrarySidebarPanel");
import type { PendingLibraryAssetSummary } from "./pendingAudioImports";

/**
 * La biblioteca en un teléfono.
 *
 * En escritorio, organizar es arrastrar: un audio a la cabecera de una carpeta,
 * una carpeta al timeline. En táctil ese arrastre no existe (pelea con el
 * desplazamiento del panel, y en vertical la biblioteca tapa el timeline
 * entero), así que la biblioteca móvil se había quedado SIN forma de meter un
 * audio en una carpeta y sin forma de llevar una carpeta al timeline. Las dos
 * entran ahora por menú de pulsación larga y por la barra de selección.
 */

function asset(
  fileName: string,
  folderPath: string | null = null,
): PendingLibraryAssetSummary {
  return {
    filePath: `D:/session/audio/${fileName}`,
    fileName,
    durationSeconds: 120,
    folderPath: folderPath ?? undefined,
  } as PendingLibraryAssetSummary;
}

function touchPointer(
  type: "pointerdown" | "pointerup",
  clientX = 40,
  clientY = 60,
) {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperties(event, {
    pointerType: { value: "touch" },
    pointerId: { value: 2 },
  });
  return event;
}

type Handlers = {
  onMoveAssetsToFolder: ReturnType<typeof vi.fn>;
  onAddFolderToTimeline: ReturnType<typeof vi.fn>;
};

function renderPanel(): Handlers {
  const handlers: Handlers = {
    onMoveAssetsToFolder: vi.fn(),
    onAddFolderToTimeline: vi.fn(),
  };

  render(
    <LibrarySidebarPanel
      assets={[asset("kick.wav"), asset("bass.wav", "Domingo")]}
      folders={["Domingo"]}
      isLoading={false}
      isImporting={false}
      importProgress={null}
      deletingFilePath={null}
      canImport
      onImport={() => {}}
      onCreateFolder={() => {}}
      onRenameFolder={() => {}}
      onDeleteFolder={() => {}}
      onDeleteRequested={() => {}}
      onAddSelectionToTimeline={() => {}}
      {...handlers}
    />,
  );

  return handlers;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// El arnés de test no fija idioma: i18next resuelve al inglés (el de reserva),
// así que las etiquetas que se buscan aquí son las de en.ts.
function longPress(element: HTMLElement) {
  fireEvent(element, touchPointer("pointerdown"));
  act(() => {
    vi.advanceTimersByTime(600);
  });
}

describe("LibrarySidebarPanel en móvil", () => {
  it("mueve un audio a una carpeta desde la pulsación larga", () => {
    const handlers = renderPanel();

    longPress(screen.getByRole("button", { name: "kick.wav" }));
    fireEvent.click(screen.getByRole("button", { name: /Move to folder/i }));
    fireEvent.click(screen.getByRole("button", { name: "Domingo" }));

    expect(handlers.onMoveAssetsToFolder).toHaveBeenCalledWith(
      ["D:/session/audio/kick.wav"],
      "Domingo",
    );
  });

  it("no ofrece como destino la carpeta en la que el audio ya está", () => {
    renderPanel();

    longPress(screen.getByRole("button", { name: "bass.wav" }));
    fireEvent.click(screen.getByRole("button", { name: /Move to folder/i }));

    expect(
      (screen.getByRole("button", { name: "Domingo" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("lleva una carpeta entera al timeline como canción", () => {
    const handlers = renderPanel();

    longPress(screen.getByText("Domingo"));
    fireEvent.click(
      screen.getByRole("button", { name: /Add to timeline as a song/i }),
    );

    expect(handlers.onAddFolderToTimeline).toHaveBeenCalledWith(
      "Domingo",
      [expect.objectContaining({ fileName: "bass.wav" })],
    );
  });

  it("ofrece «Mover a…» en la barra de la selección", () => {
    const handlers = renderPanel();

    // Un toque selecciona (en móvil cada toque alterna la selección).
    fireEvent.click(screen.getByRole("button", { name: "kick.wav" }));
    fireEvent.click(screen.getByRole("button", { name: /Move to\.\.\./i }));
    fireEvent.click(screen.getByRole("button", { name: "Domingo" }));

    expect(handlers.onMoveAssetsToFolder).toHaveBeenCalledWith(
      ["D:/session/audio/kick.wav"],
      "Domingo",
    );
  });

  it("no arranca un arrastre de carpeta con el dedo", () => {
    const onPointerDragStart = vi.fn();
    render(
      <LibrarySidebarPanel
        assets={[asset("bass.wav", "Domingo")]}
        folders={["Domingo"]}
        isLoading={false}
        isImporting={false}
        importProgress={null}
        deletingFilePath={null}
        canImport
        onPointerDragStart={onPointerDragStart}
        onImport={() => {}}
        onCreateFolder={() => {}}
        onMoveAssetsToFolder={() => {}}
        onRenameFolder={() => {}}
        onDeleteFolder={() => {}}
        onDeleteRequested={() => {}}
      />,
    );

    const header = screen.getAllByText("Domingo")[0];
    fireEvent(header, touchPointer("pointerdown"));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientX: 300 }));

    expect(onPointerDragStart).not.toHaveBeenCalled();
  });
});
