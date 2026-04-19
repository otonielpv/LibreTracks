import { render, screen } from "@testing-library/react";
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
    expect(await screen.findByText("Click")).toBeTruthy();
    expect(await screen.findByText("Guide")).toBeTruthy();
    expect(await screen.findByText("Drums")).toBeTruthy();
    expect(await screen.findByLabelText("Volumen de pista Click")).toBeTruthy();
    expect(screen.getByRole("button", { name: /importar wavs/i })).toBeTruthy();
  });
});
