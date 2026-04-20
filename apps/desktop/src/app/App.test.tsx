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

  it("keeps folder tracks integrated in the same timeline box", async () => {
    await renderApp();

    expect(screen.getByText("Rhythm")).toBeTruthy();
    expect(screen.getByText("Guide")).toBeTruthy();
    expect(screen.getByRole("slider", { name: /volumen de rhythm/i })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /volumen de drums/i })).toBeTruthy();
  });

  it("creates a time selection from the ruler and turns it into a section", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 120 });
      fireEvent.mouseMove(window, { button: 0, clientX: 420 });
      fireEvent.mouseUp(window, { button: 0, clientX: 420 });
    });

    expect(await screen.findByRole("button", { name: /crear seccion/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /crear seccion/i }));
    });

    expect(await screen.findByText(/seccion creada desde la seleccion temporal/i)).toBeTruthy();
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
      fireEvent.contextMenu(introSection, { clientX: 220, clientY: 120 });
    });

    const jumpNow = await screen.findByRole("button", { name: /ir ahora/i });
    const context = jumpNow.closest(".lt-context-menu");
    expect(context).toBeTruthy();
    expect(within(context as HTMLElement).getByRole("button", { name: /ir ahora/i })).toBeTruthy();
    expect(
      within(context as HTMLElement).getByRole("button", { name: /programar salto al final/i }),
    ).toBeTruthy();
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
});
