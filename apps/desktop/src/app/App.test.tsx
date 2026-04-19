import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("renders the main transport shell", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", {
        name: /base tecnica lista para el primer prototipo multitrack/i,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /play/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
  });

  it("shows the default group rows", () => {
    render(<App />);

    expect(screen.getAllByText("Click + Guide").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Drums + Bass").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Keys + Pads").length).toBeGreaterThan(0);
  });

  it("shows the initial track list and mixer controls", () => {
    render(<App />);

    expect(screen.getByText("Tracks")).toBeTruthy();
    expect(screen.getByText("Click")).toBeTruthy();
    expect(screen.getByText("Guide")).toBeTruthy();
    expect(screen.getByText("Drums")).toBeTruthy();
    expect(screen.getByLabelText("Volumen de pista Click")).toBeTruthy();
    expect(screen.getByRole("button", { name: /importar pistas/i })).toBeTruthy();
  });
});
