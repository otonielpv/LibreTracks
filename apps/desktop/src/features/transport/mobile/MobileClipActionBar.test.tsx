// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileClipActionBar } from "./MobileClipActionBar";
import { useTimelineUIStore } from "../uiStore";
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
  useTimelineUIStore.setState({ selectedClipId: null, selectedClipIds: [] });
});
afterEach(cleanup);

function select(...clipIds: string[]) {
  useTimelineUIStore.getState().setSelectedClipIds(clipIds);
}

describe("barra de acciones de la seleccion", () => {
  it("no ocupa sitio mientras no hay nada seleccionado", () => {
    render(<MobileClipActionBar runShortcutAction={vi.fn()} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("no aparece en escritorio", () => {
    platform.mobile = false;
    select("c1");
    render(<MobileClipActionBar runShortcutAction={vi.fn()} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("dispara la MISMA accion que el atajo, sin reimplementarla", () => {
    const runShortcutAction = vi.fn();
    select("c1", "c2");
    render(<MobileClipActionBar runShortcutAction={runShortcutAction} />);

    for (const [label, action] of [
      ["Duplicar", "edit.duplicate"],
      ["Cortar en el cabezal", "edit.splitClip"],
      ["Eliminar", "edit.delete"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(runShortcutAction).toHaveBeenLastCalledWith(action);
    }
  });

  it("dice cuantos clips van a recibir la accion", () => {
    select("c1", "c2", "c3");
    render(<MobileClipActionBar runShortcutAction={vi.fn()} />);
    expect(screen.getByRole("toolbar").textContent).toContain("3");
  });

  it("permite soltar la seleccion sin tocar el audio", () => {
    const runShortcutAction = vi.fn();
    select("c1");
    render(<MobileClipActionBar runShortcutAction={runShortcutAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Quitar selección" }));
    expect(useTimelineUIStore.getState().selectedClipIds).toEqual([]);
    expect(runShortcutAction).not.toHaveBeenCalled();
  });
});
