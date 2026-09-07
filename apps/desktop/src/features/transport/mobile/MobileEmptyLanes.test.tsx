// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileEmptyLanes } from "./MobileEmptyLanes";
import i18n from "../../../shared/i18n";

const platform = vi.hoisted(() => ({ mobile: true }));
vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  get isMobileApp() {
    return platform.mobile;
  },
}));

beforeEach(async () => {
  await i18n.changeLanguage("es");
  platform.mobile = true;
});
afterEach(cleanup);

describe("el vacio propone el primer paso", () => {
  it("con cero pistas ofrece el mensaje y el boton", () => {
    render(<MobileEmptyLanes trackCount={0} onAddAudios={vi.fn()} />);
    expect(screen.getByText("Aún no hay audio en esta sesión")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Añadir audios/ })).toBeTruthy();
  });

  it("no roba sitio en cuanto hay una pista", () => {
    render(<MobileEmptyLanes trackCount={1} onAddAudios={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("el escritorio no cambia", () => {
    platform.mobile = false;
    render(<MobileEmptyLanes trackCount={0} onAddAudios={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("el boton llama al flujo de importacion existente, no a uno propio", () => {
    const onAddAudios = vi.fn();
    render(<MobileEmptyLanes trackCount={0} onAddAudios={onAddAudios} />);
    fireEvent.click(screen.getByRole("button", { name: /Añadir audios/ }));
    expect(onAddAudios).toHaveBeenCalledTimes(1);
  });
});
