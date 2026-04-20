import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
});

async function renderApp() {
  const { App } = await import("./App");
  const view = render(<App />);
  await screen.findByText(/modo demo web/i);
  return view;
}

function dispatchPointerEvent(
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  options: { clientX?: number; clientY?: number; pointerId?: number } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });

  Object.defineProperties(event, {
    clientX: { configurable: true, value: options.clientX ?? 0 },
    clientY: { configurable: true, value: options.clientY ?? 0 },
    pointerId: { configurable: true, value: options.pointerId ?? 1 },
  });

  fireEvent(element, event);
}

function mockTimelineLayout(container: HTMLElement) {
  const timelineScroll = container.querySelector(".timeline-scroll") as HTMLDivElement | null;
  const timelineContent = container.querySelector(".timeline-content") as HTMLDivElement | null;

  expect(timelineScroll).toBeTruthy();
  expect(timelineContent).toBeTruthy();

  Object.defineProperty(timelineScroll, "clientWidth", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(timelineContent, "scrollWidth", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(timelineScroll, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: 1000,
      top: 0,
      bottom: 80,
      width: 1000,
      height: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  Object.defineProperty(timelineContent, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: 1000,
      top: 0,
      bottom: 80,
      width: 1000,
      height: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

describe("App", () => {
  it("renders the main DAW shell", async () => {
    await renderApp();

    expect(
      screen.getByRole("heading", {
        name: /libretracks timeline daw/i,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /play/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
    expect(await screen.findByText(/modo demo web/i)).toBeTruthy();
  });

  it("shows the integrated group strip once the demo snapshot is loaded", async () => {
    await renderApp();

    expect(await screen.findByText("Submezclas")).toBeTruthy();
    expect((await screen.findAllByText("Click + Guide")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Drums + Bass")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Keys + Pads")).length).toBeGreaterThan(0);
  });

  it("shows the loaded track headers and timeline controls", async () => {
    await renderApp();

    expect(await screen.findByText("Timeline principal")).toBeTruthy();
    expect(await screen.findByLabelText(/zoom horizontal del timeline/i)).toBeTruthy();
    expect(await screen.findByLabelText("Volumen de pista Click")).toBeTruthy();
    expect(await screen.findByLabelText("Grupo de pista Click")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /importar wavs/i })).toBeTruthy();
  });

  it("allows selecting a clip in the timeline", async () => {
    await renderApp();

    const clipButton = await screen.findByRole("button", { name: /clip drums/i });
    await act(async () => {
      fireEvent.pointerDown(clipButton, { pointerId: 1, clientX: 16 });
      fireEvent.pointerUp(clipButton, { pointerId: 1, clientX: 16 });
    });

    expect(await screen.findByText(/clip seleccionado: drums/i)).toBeTruthy();
    expect(await screen.findByDisplayValue("16.00")).toBeTruthy();
  });

  it("supports space to play and pause", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });

    expect(await screen.findByText(/reproduccion en curso/i)).toBeTruthy();
    expect(await screen.findByText("playing")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });

    expect(await screen.findByText(/reproduccion pausada/i)).toBeTruthy();
    expect(await screen.findByText("paused")).toBeTruthy();
  });

  it("supports escape to clear timeline selections", async () => {
    await renderApp();

    const clipButton = await screen.findByRole("button", { name: /clip drums/i });
    await act(async () => {
      fireEvent.pointerDown(clipButton, { pointerId: 1, clientX: 16 });
      fireEvent.pointerUp(clipButton, { pointerId: 1, clientX: 16 });
    });

    expect(await screen.findByText(/clip seleccionado: drums/i)).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    expect(await screen.findByText(/seleccion del timeline cancelada/i)).toBeTruthy();
    expect(await screen.findByText(/sin clip seleccionado/i)).toBeTruthy();
  });

  it("allows deleting a clip from the timeline context dock", async () => {
    await renderApp();

    const bassClip = await screen.findByRole("button", { name: /clip bass/i });
    await act(async () => {
      fireEvent.pointerDown(bassClip, { pointerId: 1, clientX: 32 });
      fireEvent.pointerUp(bassClip, { pointerId: 1, clientX: 32 });
    });

    const deleteButton = await screen.findByRole("button", { name: /borrar clip/i });
    await act(async () => {
      fireEvent.click(deleteButton);
    });

    expect(await screen.findByText(/clip eliminado: bass/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /clip bass/i })).toBeNull();
  });

  it("allows updating the selected clip window from the context dock", async () => {
    await renderApp();

    const drumsClip = await screen.findByRole("button", { name: /clip drums/i });
    await act(async () => {
      fireEvent.pointerDown(drumsClip, { pointerId: 1, clientX: 16 });
      fireEvent.pointerUp(drumsClip, { pointerId: 1, clientX: 16 });
    });

    await act(async () => {
      fireEvent.change(await screen.findByLabelText(/inicio del clip en segundos/i), {
        target: { value: "20.00" },
      });
      fireEvent.change(await screen.findByLabelText(/entrada del clip en segundos/i), {
        target: { value: "4.00" },
      });
      fireEvent.change(await screen.findByLabelText(/duracion del clip en segundos/i), {
        target: { value: "120.00" },
      });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /aplicar clip/i }));
    });

    expect(await screen.findByText(/clip actualizado: drums/i)).toBeTruthy();
    expect(await screen.findByDisplayValue("20.00")).toBeTruthy();
    expect(await screen.findByDisplayValue("4.00")).toBeTruthy();
    expect(await screen.findByDisplayValue("120.00")).toBeTruthy();
  });

  it("allows trimming a clip start directly from timeline handles", async () => {
    const { container } = await renderApp();
    mockTimelineLayout(container);

    const startHandle = await screen.findByRole("button", { name: /recortar inicio de drums/i });
    await act(async () => {
      dispatchPointerEvent(startHandle, "pointerdown", { pointerId: 4, clientX: 67 });
      dispatchPointerEvent(startHandle, "pointermove", { pointerId: 4, clientX: 100 });
      dispatchPointerEvent(startHandle, "pointerup", { pointerId: 4, clientX: 100 });
    });

    expect(await screen.findByText(/clip ajustado: drums/i)).toBeTruthy();
    expect(await screen.findByDisplayValue("24.00")).toBeTruthy();
    expect(await screen.findByDisplayValue("8.00")).toBeTruthy();
    expect(await screen.findByDisplayValue("168.00")).toBeTruthy();
  });

  it("allows trimming a clip end directly from timeline handles", async () => {
    const { container } = await renderApp();
    mockTimelineLayout(container);

    const endHandle = await screen.findByRole("button", { name: /recortar fin de drums/i });
    await act(async () => {
      dispatchPointerEvent(endHandle, "pointerdown", { pointerId: 5, clientX: 800 });
      dispatchPointerEvent(endHandle, "pointermove", { pointerId: 5, clientX: 600 });
      dispatchPointerEvent(endHandle, "pointerup", { pointerId: 5, clientX: 600 });
    });

    expect(await screen.findByText(/clip ajustado: drums/i)).toBeTruthy();
    expect(await screen.findByDisplayValue("16.00")).toBeTruthy();
    expect(await screen.findByDisplayValue("0.00")).toBeTruthy();
    expect(await screen.findByDisplayValue("128.00")).toBeTruthy();
  });

  it("allows moving a clip directly across the timeline", async () => {
    const { container } = await renderApp();
    mockTimelineLayout(container);

    const drumsClip = await screen.findByRole("button", { name: /clip drums/i });
    await act(async () => {
      dispatchPointerEvent(drumsClip, "pointerdown", { pointerId: 6, clientX: 67 });
      dispatchPointerEvent(drumsClip, "pointermove", { pointerId: 6, clientX: 100 });
      dispatchPointerEvent(drumsClip, "pointerup", { pointerId: 6, clientX: 100 });
    });

    expect(await screen.findByText(/drums movido/i)).toBeTruthy();
    expect(await screen.findByDisplayValue("23.92")).toBeTruthy();
  });

  it("allows duplicating the selected clip from the context dock", async () => {
    await renderApp();

    const drumsClip = await screen.findByRole("button", { name: /clip drums/i });
    await act(async () => {
      fireEvent.pointerDown(drumsClip, { pointerId: 1, clientX: 16 });
      fireEvent.pointerUp(drumsClip, { pointerId: 1, clientX: 16 });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /duplicar clip/i }));
    });

    expect(await screen.findByText(/drums duplicado/i)).toBeTruthy();
    expect((await screen.findAllByRole("button", { name: /clip drums/i })).length).toBe(2);
  });

  it("supports delete to remove the selected clip", async () => {
    await renderApp();

    const keysClip = await screen.findByRole("button", { name: /clip keys/i });
    await act(async () => {
      fireEvent.pointerDown(keysClip, { pointerId: 1, clientX: 48 });
      fireEvent.pointerUp(keysClip, { pointerId: 1, clientX: 48 });
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Delete" });
    });

    expect(await screen.findByText(/clip eliminado: keys/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /clip keys/i })).toBeNull();
  });

  it("supports ctrl d to duplicate the selected clip", async () => {
    await renderApp();

    const drumsClip = await screen.findByRole("button", { name: /clip drums/i });
    await act(async () => {
      fireEvent.pointerDown(drumsClip, { pointerId: 1, clientX: 16 });
      fireEvent.pointerUp(drumsClip, { pointerId: 1, clientX: 16 });
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    });

    expect(await screen.findByText(/drums duplicado/i)).toBeTruthy();
    expect((await screen.findAllByRole("button", { name: /clip drums/i })).length).toBe(2);
  });

  it("supports arrow keys to nudge the selected clip", async () => {
    await renderApp();

    const drumsClip = await screen.findByRole("button", { name: /clip drums/i });
    await act(async () => {
      fireEvent.pointerDown(drumsClip, { pointerId: 1, clientX: 16 });
      fireEvent.pointerUp(drumsClip, { pointerId: 1, clientX: 16 });
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });

    expect(await screen.findByText(/drums movido/i)).toBeTruthy();
    expect(await screen.findByDisplayValue("17.00")).toBeTruthy();
  });

  it("supports snap beat when applying clip moves", async () => {
    await renderApp();

    const drumsClip = await screen.findByRole("button", { name: /clip drums/i });
    await act(async () => {
      fireEvent.pointerDown(drumsClip, { pointerId: 1, clientX: 16 });
      fireEvent.pointerUp(drumsClip, { pointerId: 1, clientX: 16 });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /snap beat/i }));
    });

    await act(async () => {
      fireEvent.change(await screen.findByLabelText(/inicio del clip en segundos/i), {
        target: { value: "17.00" },
      });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /aplicar clip/i }));
    });

    expect(await screen.findByDisplayValue("16.67")).toBeTruthy();
  });

  it("supports ctrl plus mouse wheel to zoom the timeline", async () => {
    const { container } = await renderApp();

    const zoomField = (await screen.findByLabelText(
      /zoom horizontal del timeline/i,
    )) as HTMLInputElement;
    expect(zoomField.value).toBe("1.75");

    const timelineScroll = container.querySelector(".timeline-scroll");
    expect(timelineScroll).toBeTruthy();

    await act(async () => {
      fireEvent.wheel(timelineScroll as Element, {
        ctrlKey: true,
        deltaY: -100,
        clientX: 240,
      });
    });

    expect(zoomField.value).toBe("2");
    expect(await screen.findByText(/zoom 2\.0x/i)).toBeTruthy();
  });

  it("creates a blank project from the transport header", async () => {
    await renderApp();

    const createButton = await screen.findByRole("button", { name: /crear cancion/i });
    await act(async () => {
      fireEvent.click(createButton);
    });

    expect(await screen.findByText(/proyecto creado/i)).toBeTruthy();
    expect((await screen.findAllByText("Nueva Cancion")).length).toBeGreaterThan(0);
  });

  it("allows editing a section from the timeline context dock", async () => {
    await renderApp();

    const verseSection = await screen.findByRole("button", { name: "Verse" });
    await act(async () => {
      fireEvent.click(verseSection);
    });

    const nameField = await screen.findByLabelText(/nombre de la seccion/i);
    const startField = await screen.findByLabelText(/inicio de la seccion en segundos/i);
    const endField = await screen.findByLabelText(/fin de la seccion en segundos/i);

    await act(async () => {
      fireEvent.change(nameField, { target: { value: "Verse A" } });
      fireEvent.change(startField, { target: { value: "36.00" } });
      fireEvent.change(endField, { target: { value: "108.00" } });
    });

    const applyButton = await screen.findByRole("button", { name: /aplicar cambios/i });
    await act(async () => {
      fireEvent.click(applyButton);
    });

    expect(await screen.findByText(/seccion actualizada: verse a/i)).toBeTruthy();
    expect(await screen.findByDisplayValue("Verse A")).toBeTruthy();
    expect(await screen.findByDisplayValue("36.00")).toBeTruthy();
    expect(await screen.findByDisplayValue("108.00")).toBeTruthy();
  });

  it("allows resizing a section directly from the timeline ruler handles", async () => {
    const { container } = await renderApp();
    mockTimelineLayout(container);

    const startHandle = await screen.findByRole("button", { name: /ajustar inicio de verse/i });
    await act(async () => {
      dispatchPointerEvent(startHandle, "pointerdown", { pointerId: 3, clientX: 133 });
      dispatchPointerEvent(startHandle, "pointermove", { pointerId: 3, clientX: 167 });
      dispatchPointerEvent(startHandle, "pointerup", { pointerId: 3, clientX: 167 });
    });

    expect(await screen.findByDisplayValue("40.08")).toBeTruthy();
  });

  it("allows deleting a section from the timeline context dock", async () => {
    await renderApp();

    const chorusSection = await screen.findByRole("button", { name: "Chorus" });
    await act(async () => {
      fireEvent.click(chorusSection);
    });

    const deleteButton = await screen.findByRole("button", { name: /borrar seccion/i });
    await act(async () => {
      fireEvent.click(deleteButton);
    });

    expect(await screen.findByText(/seccion eliminada: chorus/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chorus" })).toBeNull();
  });

  it("allows scheduling and cancelling a section jump from the main dock", async () => {
    await renderApp();

    const chorusSection = await screen.findByRole("button", { name: "Chorus" });
    await act(async () => {
      fireEvent.click(chorusSection);
    });

    await act(async () => {
      fireEvent.change(await screen.findByLabelText(/compases del salto/i), {
        target: { value: "6" },
      });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /en compases/i }));
    });

    expect(await screen.findByText(/salto de seccion programado/i)).toBeTruthy();
    expect(await screen.findByText(/salto armado hacia chorus/i)).toBeTruthy();
    expect(await screen.findByText(/ejecucion estimada en 00:20\.000/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /cancelar salto/i }));
    });

    expect(await screen.findByText(/salto pendiente cancelado/i)).toBeTruthy();
    expect(await screen.findByText(/sin salto programado/i)).toBeTruthy();
  });

  it("creates a new group from the integrated submix controls", async () => {
    await renderApp();

    const nameField = await screen.findByLabelText(/nombre del nuevo grupo/i);
    await act(async () => {
      fireEvent.change(nameField, { target: { value: "Vocals" } });
    });

    const createGroupButton = await screen.findByRole("button", { name: /crear grupo/i });
    await act(async () => {
      fireEvent.click(createGroupButton);
    });

    expect(await screen.findByText(/grupo creado: vocals/i)).toBeTruthy();
    expect((await screen.findAllByText("Vocals")).length).toBeGreaterThan(0);
  });
});
