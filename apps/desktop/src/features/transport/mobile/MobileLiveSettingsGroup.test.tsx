// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileLiveSettingsGroup } from "./MobileLiveSettingsGroup";
import i18n from "../../../shared/i18n";

const platform = vi.hoisted(() => ({ mobile: true }));
vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  get isMobileApp() {
    return platform.mobile;
  },
}));

function renderGroup() {
  render(
    <MobileLiveSettingsGroup>
      <button type="button">Vamp</button>
      <button type="button">Salto de marca</button>
      <button type="button">Master</button>
    </MobileLiveSettingsGroup>,
  );
}

const toggle = () => screen.getByRole("button", { name: /Directo/ });

beforeEach(async () => {
  await i18n.changeLanguage("es");
  platform.mobile = true;
  window.localStorage.clear();
});
afterEach(cleanup);

describe("los ajustes de directo, agrupados pero accesibles", () => {
  it("en escritorio no cambia nada: ni envoltorio ni boton", () => {
    platform.mobile = false;
    renderGroup();
    expect(screen.queryByRole("button", { name: /Directo/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Vamp" })).toBeTruthy();
  });

  it("sesion nueva en movil: cerrado, y la barra deja sitio", () => {
    renderGroup();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Vamp" })).toBeNull();
  });

  it("abrirlo da acceso a TODOS los controles actuales, sin recortar", () => {
    renderGroup();
    fireEvent.click(toggle());
    for (const name of ["Vamp", "Salto de marca", "Master"]) {
      expect(screen.getByRole("button", { name }), name).toBeTruthy();
    }
  });

  it("su estado sobrevive a cerrar y reabrir la app", () => {
    renderGroup();
    fireEvent.click(toggle());
    cleanup();

    // Segundo arranque: quien toca en directo lo dejo abierto.
    renderGroup();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Vamp" })).toBeTruthy();
  });

  it("sin almacenamiento arranca cerrado en vez de reventar", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("modo privado");
      });
    try {
      renderGroup();
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
    } finally {
      getItem.mockRestore();
    }
  });
});
