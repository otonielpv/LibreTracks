import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

async function renderApp() {
  const { App } = await import("./App");
  const view = render(<App />);
  await screen.findByText(/modo demo web/i);
  return view;
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

  it("creates a blank project from the transport header", async () => {
    await renderApp();

    const createButton = await screen.findByRole("button", { name: /crear cancion/i });
    await act(async () => {
      fireEvent.click(createButton);
    });

    expect(await screen.findByText(/proyecto creado/i)).toBeTruthy();
    expect((await screen.findAllByText("Nueva Cancion")).length).toBeGreaterThan(0);
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
