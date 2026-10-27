// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";

const listSessionTemplates = vi.fn();
const undoAction = vi.fn();
let emitDropSummary: ((summary: { matched: number; unmatched: number }) => void) | null =
  null;

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  listSessionTemplates: () => listSessionTemplates(),
  undoAction: () => undoAction(),
  listenToTemplateDropSummary: (
    handler: (summary: { matched: number; unmatched: number }) => void,
  ) => {
    emitDropSummary = handler;
    return Promise.resolve(() => {
      emitDropSummary = null;
    });
  },
}));

const { parseMatchAliases, formatMatchAliases } = await import("./matchAliases");
const { NewSongTemplateMenu } = await import("./NewSongTemplateMenu");
const { DefaultSongTemplateField } = await import("./DefaultSongTemplateField");
const { TemplateDropToast } = await import("./TemplateDropToast");

const MY_TEMPLATE = { name: "Mi banda", path: "/tpl/Mi banda.lttemplate" };

beforeEach(async () => {
  vi.clearAllMocks();
  listSessionTemplates.mockResolvedValue([MY_TEMPLATE]);
  await (await import("../../../shared/i18n")).default.changeLanguage("es");
});
afterEach(cleanup);

describe("reglas de coincidencia", () => {
  it("separa por comas, punto y coma o saltos de línea y quita los huecos", () => {
    expect(parseMatchAliases(" EG, Guitarra ; ,gtr\nAG ")).toEqual([
      "EG",
      "Guitarra",
      "gtr",
      "AG",
    ]);
    expect(parseMatchAliases("  ")).toEqual([]);
  });

  it("se muestran como se escriben", () => {
    expect(formatMatchAliases(["EG", "Gtr"])).toBe("EG, Gtr");
    expect(formatMatchAliases(undefined)).toBe("");
  });
});

describe("Nueva canción desde plantilla", () => {
  it("abre fuera de la fila con scroll y cierra con Escape o al pulsar fuera", async () => {
    const { container } = render(<NewSongTemplateMenu onCreate={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /desde plantilla/i });

    fireEvent.click(toggle);
    const menu = await screen.findByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.position).toBe("fixed");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(toggle);
    await screen.findByRole("menu");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ofrece «Sin plantilla», la de serie y las del usuario", async () => {
    const onCreate = vi.fn();
    render(<NewSongTemplateMenu onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: /desde plantilla/i }));
    const mine = await screen.findByRole("menuitem", { name: "Mi banda" });
    expect(screen.getByRole("menuitem", { name: "Sin plantilla" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Banda (incluida)" })).toBeTruthy();

    fireEvent.click(mine);
    expect(onCreate).toHaveBeenCalledWith(MY_TEMPLATE.path);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("«Sin plantilla» pide una canción vacía aunque haya una por defecto", async () => {
    const onCreate = vi.fn();
    render(<NewSongTemplateMenu onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: /desde plantilla/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sin plantilla" }));
    expect(onCreate).toHaveBeenCalledWith("none");
  });
});

describe("Ajustes › Plantilla para canciones nuevas", () => {
  it("guarda la plantilla elegida, y «Ninguna» como null", async () => {
    const onChange = vi.fn();
    render(<DefaultSongTemplateField value={null} disabled={false} onChange={onChange} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await screen.findByRole("option", { name: "Mi banda" });

    fireEvent.change(select, { target: { value: MY_TEMPLATE.path } });
    expect(onChange).toHaveBeenLastCalledWith(MY_TEMPLATE.path);
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("una plantilla que ya no está se queda elegida y lo dice", async () => {
    render(
      <DefaultSongTemplateField
        value="/tpl/Borrada.lttemplate"
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByRole("option", { name: "Borrada (no encontrada)" })).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "/tpl/Borrada.lttemplate",
    );
    expect(screen.getByText(/no se encuentra el archivo/i)).toBeTruthy();
  });

  it("la de serie nunca cuenta como no encontrada", async () => {
    render(
      <DefaultSongTemplateField value="builtin:band" disabled={false} onChange={vi.fn()} />,
    );
    await screen.findByRole("option", { name: "Mi banda" });
    expect(screen.queryByText(/no encontrada/i)).toBeNull();
  });
});

describe("aviso tras soltar audios", () => {
  it("cuenta los organizados y los sin regla, y Deshacer deshace el drop", async () => {
    const snapshot = { revision: 7 };
    undoAction.mockResolvedValue(snapshot);
    const onUndone = vi.fn();
    render(<TemplateDropToast onUndone={onUndone} />);
    await waitFor(() => expect(emitDropSummary).not.toBeNull());

    act(() => emitDropSummary?.({ matched: 12, unmatched: 2 }));
    expect(screen.getByRole("status").textContent).toContain(
      "12 audios organizados con la plantilla · 2 sin regla",
    );

    fireEvent.click(screen.getByRole("button", { name: "Deshacer" }));
    await waitFor(() => expect(onUndone).toHaveBeenCalledWith(snapshot));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("no dice nada si la plantilla no organizó ninguno", async () => {
    render(<TemplateDropToast onUndone={vi.fn()} />);
    await waitFor(() => expect(emitDropSummary).not.toBeNull());
    act(() => emitDropSummary?.({ matched: 0, unmatched: 3 }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
