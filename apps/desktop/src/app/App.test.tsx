import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

async function renderApp() {
  const { App } = await import("./App");
  const view = render(<App />);
  await screen.findByText(/modo demo web activo/i);
  await screen.findByText("Rhythm");
  return view;
}

function mockRulerBounds(container: HTMLElement) {
  const rulerTrack = container.querySelector(".lt-ruler-track") as HTMLDivElement | null;
  expect(rulerTrack).toBeTruthy();

  Object.defineProperty(rulerTrack, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: 1200,
      top: 0,
      bottom: 86,
      width: 1200,
      height: 86,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

function mockTimelineShellMetrics(container: HTMLElement, width = 1400) {
  const shell = container.querySelector(".lt-timeline-shell") as HTMLDivElement | null;
  expect(shell).toBeTruthy();

  Object.defineProperty(shell, "clientWidth", {
    configurable: true,
    value: width,
  });

  Object.defineProperty(shell, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: width,
      top: 0,
      bottom: 500,
      width,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });

  Object.defineProperty(shell, "scrollLeft", {
    configurable: true,
    writable: true,
    value: 0,
  });

  return shell as HTMLDivElement;
}

function mockTrackRowDragGeometry(container: HTMLElement) {
  const rows = Array.from(container.querySelectorAll(".lt-track-row")) as HTMLDivElement[];
  expect(rows.length).toBeGreaterThan(0);

  rows.forEach((row, index) => {
    const top = 120 + index * 84;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 1400,
        top,
        bottom: top + 78,
        width: 1400,
        height: 78,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }),
    });
  });

  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn((_x: number, y: number) => {
      return rows.find((_, index) => {
        const top = 120 + index * 84;
        return y >= top && y <= top + 78;
      }) ?? null;
    }),
  });
}

describe("App", () => {
  it("renders the timeline-centric DAW shell", async () => {
    await renderApp();

    expect(screen.getByRole("heading", { name: /timeline daw/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /play/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
    expect(screen.getByText(/vista principal/i)).toBeTruthy();
    expect(screen.queryByText(/submezclas/i)).toBeNull();
  });

  it("supports transport shortcuts from the keyboard", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });

    expect(await screen.findByText(/reproduccion iniciada/i)).toBeTruthy();
    expect(await screen.findByText("playing")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });

    expect(await screen.findByText(/reproduccion pausada/i)).toBeTruthy();
    expect(await screen.findByText("paused")).toBeTruthy();
  });

  it("keeps folder tracks integrated in the same timeline box", async () => {
    await renderApp();

    expect(screen.getByText("Rhythm")).toBeTruthy();
    expect(screen.getByText("Guide")).toBeTruthy();
    expect(screen.getByRole("slider", { name: /volumen de rhythm/i })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /volumen de drums/i })).toBeTruthy();
  });

  it("creates a time selection from the ruler and turns it into a marker", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 120 });
      fireEvent.mouseMove(window, { button: 0, clientX: 420 });
      fireEvent.mouseUp(window, { button: 0, clientX: 420 });
    });

    expect(await screen.findByRole("button", { name: /crear marca/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /crear marca/i }));
    });

    expect(await screen.findByText(/marca creada desde la seleccion temporal/i)).toBeTruthy();
    expect(screen.getByText("Seccion 5")).toBeTruthy();
  });

  it("opens the clip context menu and allows splitting at the cursor", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 320 });
    });
    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 320 });
      fireEvent.mouseUp(window, { button: 0, clientX: 320 });
    });

    const drumsClip = await screen.findByRole("button", { name: /clip drums/i });
    await act(async () => {
      fireEvent.contextMenu(drumsClip, { clientX: 280, clientY: 200 });
    });

    const splitAction = await screen.findByRole("button", { name: /cortar en cursor/i });
    expect(splitAction.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(splitAction);
    });

    expect(await screen.findByText(/clip cortado/i)).toBeTruthy();
    expect((await screen.findAllByRole("button", { name: /clip drums/i })).length).toBeGreaterThan(1);
  });

  it("shows the section context menu on right click", async () => {
    await renderApp();

    const introSection = await screen.findByRole("button", { name: "Intro" });
    await act(async () => {
      fireEvent.click(introSection);
    });

    await act(async () => {
      fireEvent.contextMenu(introSection, { clientX: 220, clientY: 120 });
    });

    const jumpNow = await screen.findByRole("button", { name: /ir ahora/i });
    const context = jumpNow.closest(".lt-context-menu");
    expect(context).toBeTruthy();
    expect(within(context as HTMLElement).getByRole("button", { name: /ir ahora/i })).toBeTruthy();
    expect(
      within(context as HTMLElement).getByRole("button", { name: /disparar con modo global/i }),
    ).toBeTruthy();
  });

  it("triggers marker jump with digit keys and cancels with escape", async () => {
    await renderApp();

    const modeSelect = await screen.findByRole("combobox", { name: /modo global de salto/i });
    await act(async () => {
      fireEvent.change(modeSelect, { target: { value: "section_end" } });
    });

    await act(async () => {
      fireEvent.keyDown(window, { code: "Digit2", key: "2" });
    });

    expect(await screen.findByText(/salto armado al final de seccion hacia verse/i)).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Escape", key: "Escape" });
    });

    expect(await screen.findByText(/salto cancelado/i)).toBeTruthy();
  });

  it("pans the timeline by dragging over an empty lane", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    const firstLane = container.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(firstLane).toBeTruthy();

    Object.defineProperty(shell, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 120,
    });

    await act(async () => {
      fireEvent.mouseDown(firstLane as HTMLElement, { button: 0, clientX: 300 });
      fireEvent.mouseMove(window, { clientX: 220 });
      fireEvent.mouseUp(window, { button: 0, clientX: 220 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBe(200);
  });

  it("collapses folder children locally in the UI", async () => {
    await renderApp();

    const toggle = await screen.findByRole("button", { name: /colapsar rhythm/i });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(screen.queryByText("Drums")).toBeNull();
    expect(screen.queryByText("Bass")).toBeNull();
    expect(await screen.findByRole("button", { name: /expandir rhythm/i })).toBeTruthy();
  });

  it("supports ctrl plus wheel zoom on the timeline shell", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    mockRulerBounds(container);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 900 });
    });
    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 900 });
      fireEvent.mouseUp(window, { button: 0, clientX: 900 });
    });

    expect(await screen.findByText(/cursor movido a 02:15.000/i)).toBeTruthy();

    const zoomSlider = screen.getByRole("slider", { name: /zoom horizontal del timeline/i });
    expect(Number(zoomSlider.getAttribute("min"))).toBeLessThan(1);

    await act(async () => {
      fireEvent.wheel(shell, { deltaY: -100, ctrlKey: true, clientX: 900 });
    });

    expect(screen.getByText("8.3x")).toBeTruthy();
  });

  it("creates a new audio track from the track context menu", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Nueva pista");
    await renderApp();

    const keysHeader = screen.getByText("Keys").closest(".lt-track-header");
    expect(keysHeader).toBeTruthy();

    await act(async () => {
      fireEvent.contextMenu(keysHeader as HTMLElement, { clientX: 180, clientY: 300 });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /insertar track/i }));
    });

    expect(await screen.findByText(/track creado: nueva pista/i)).toBeTruthy();
    expect(screen.getByText("Nueva pista")).toBeTruthy();
  });

  it("reorders tracks vertically from the header drag handle", async () => {
    const { container } = await renderApp();
    mockTrackRowDragGeometry(container);

    const dragHandle = screen.getByRole("button", { name: /mover keys/i });
    expect(dragHandle).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(dragHandle, { button: 0, clientX: 80, clientY: 470 });
    });

    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 80, clientY: 380 });
      fireEvent.mouseUp(window, { button: 0, clientX: 80, clientY: 380 });
    });

    expect(await screen.findByText(/track reordenado encima de guide/i)).toBeTruthy();
  });

  it("allows dragging a track into a folder track", async () => {
    const { container } = await renderApp();
    mockTrackRowDragGeometry(container);

    const dragHandle = screen.getByRole("button", { name: /mover keys/i });
    expect(dragHandle).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(dragHandle, { button: 0, clientX: 80, clientY: 470 });
    });

    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 80, clientY: 410 });
      fireEvent.mouseUp(window, { button: 0, clientX: 80, clientY: 410 });
    });

    expect(await screen.findByText(/track movido dentro de guide/i)).toBeTruthy();
  });
});
