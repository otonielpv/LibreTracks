import { fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("renders the main transport shell", async () => {
    render(<App />);

    expect(
      screen.getByRole("heading", {
        name: /importa wavs y prueba el primer reproductor multitrack/i,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /play/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
    expect(await screen.findByText(/modo demo web/i)).toBeTruthy();
  });

  it("shows the default group rows once the demo snapshot is loaded", async () => {
    render(<App />);

    expect((await screen.findAllByText("Click + Guide")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Drums + Bass")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Keys + Pads")).length).toBeGreaterThan(0);
  });

  it("shows the loaded track list and mixer controls", async () => {
    render(<App />);

    expect(screen.getByText("Tracks")).toBeTruthy();
    expect(await screen.findByText("Timeline")).toBeTruthy();
    expect(await screen.findByText(/cursor y secciones sobre la propia linea de tiempo/i)).toBeTruthy();
    expect(await screen.findByLabelText(/zoom horizontal del timeline/i)).toBeTruthy();
    expect((await screen.findAllByText("Click")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Guide")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Drums")).length).toBeGreaterThan(0);
    expect(await screen.findByLabelText("Volumen de pista Click")).toBeTruthy();
    expect(screen.getByRole("button", { name: /importar wavs/i })).toBeTruthy();
  });

  it("allows selecting a clip in the timeline", async () => {
    render(<App />);

    const clipButton = await screen.findByRole("button", { name: /clip drums/i });
    fireEvent.click(clipButton);

    expect(await screen.findByText(/clip seleccionado: drums/i)).toBeTruthy();
  });

  it("allows moving the selected clip from the inspector", async () => {
    render(<App />);

    const clipButton = await screen.findByRole("button", { name: /clip drums/i });
    fireEvent.click(clipButton);

    const moveButton = await screen.findByRole("button", { name: /^\+1s$/i });
    fireEvent.click(moveButton);

    expect(await screen.findByDisplayValue("17.00")).toBeTruthy();
    expect(await screen.findByText(/inicio 00:17.000/i)).toBeTruthy();
  });

  it("creates a blank project from the transport header", async () => {
    render(<App />);

    const createButton = await screen.findByRole("button", { name: /crear cancion/i });
    fireEvent.click(createButton);

    expect(await screen.findByText("Nueva Cancion")).toBeTruthy();
    expect(await screen.findByText(/proyecto creado/i)).toBeTruthy();
  });
});
