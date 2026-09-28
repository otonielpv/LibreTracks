// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ContextMenuState } from "../types";
import { TimelineContextMenus } from "./TimelineContextMenus";

// Mismo patron que `markerKindMenus`: cada submenu es una opcion que cierra el
// menu actual y abre otro en su sitio con `setContextMenu`.
function Harness({ onLeaf }: { onLeaf: () => void }) {
  const [menu, setMenu] = useState<ContextMenuState>(null);
  const openVariants = () =>
    setMenu({
      x: 0,
      y: 0,
      title: "Estrofa",
      actions: [{ label: "Estrofa 1", onSelect: onLeaf }],
    });
  const openSections = () =>
    setMenu({
      x: 0,
      y: 0,
      title: "Secciones",
      actions: [{ label: "Estrofa ▸", onSelect: openVariants }],
    });
  const openRoot = () =>
    setMenu({
      x: 0,
      y: 0,
      title: "Crear marca",
      actions: [
        { label: "Secciones ▸", onSelect: openSections },
        { label: "Personalizada", onSelect: onLeaf },
      ],
    });
  return (
    <>
      <button type="button" onClick={openRoot}>
        abrir
      </button>
      <TimelineContextMenus
        contextMenu={menu}
        onDismiss={() => setMenu(null)}
        onNavigate={setMenu}
      />
    </>
  );
}

const backButton = () =>
  document.querySelector<HTMLButtonElement>(".lt-context-menu-back");

describe("TimelineContextMenus — atras en submenus", () => {
  it("el menu raiz no tiene atras", () => {
    render(<Harness onLeaf={vi.fn()} />);
    fireEvent.click(screen.getByText("abrir"));
    expect(screen.getByText("Crear marca")).toBeTruthy();
    expect(backButton()).toBeNull();
  });

  it("vuelve nivel a nivel hasta el menu raiz", () => {
    render(<Harness onLeaf={vi.fn()} />);
    fireEvent.click(screen.getByText("abrir"));
    fireEvent.click(screen.getByText("Secciones ▸"));
    fireEvent.click(screen.getByText("Estrofa ▸"));
    expect(screen.getByText("Estrofa 1")).toBeTruthy();

    fireEvent.click(backButton()!);
    expect(screen.getByText("Estrofa ▸")).toBeTruthy();
    expect(backButton()).not.toBeNull();

    fireEvent.click(backButton()!);
    expect(screen.getByText("Crear marca")).toBeTruthy();
    expect(backButton()).toBeNull();

    // Y desde el raiz se puede volver a bajar con la pila bien formada.
    fireEvent.click(screen.getByText("Secciones ▸"));
    fireEvent.click(backButton()!);
    expect(screen.getByText("Crear marca")).toBeTruthy();
  });

  it("una accion final cierra el menu y la pila no se arrastra al siguiente", () => {
    const onLeaf = vi.fn();
    render(<Harness onLeaf={onLeaf} />);
    fireEvent.click(screen.getByText("abrir"));
    fireEvent.click(screen.getByText("Secciones ▸"));
    fireEvent.click(screen.getByText("Estrofa ▸"));
    fireEvent.click(screen.getByText("Estrofa 1"));
    expect(onLeaf).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Estrofa 1")).toBeNull();

    fireEvent.click(screen.getByText("abrir"));
    expect(backButton()).toBeNull();
  });

  it("un menu abierto desde fuera sobre un submenu no ofrece volver", () => {
    render(<Harness onLeaf={vi.fn()} />);
    fireEvent.click(screen.getByText("abrir"));
    fireEvent.click(screen.getByText("Secciones ▸"));
    expect(backButton()).not.toBeNull();
    // Otro clic derecho: abre un menu nuevo sin pasar por una opcion.
    fireEvent.click(screen.getByText("abrir"));
    expect(backButton()).toBeNull();
  });
});
