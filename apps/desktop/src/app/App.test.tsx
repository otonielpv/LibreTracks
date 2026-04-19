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

    expect(screen.getByText("Click + Guide")).toBeTruthy();
    expect(screen.getByText("Drums + Bass")).toBeTruthy();
    expect(screen.getByText("Keys + Pads")).toBeTruthy();
  });
});
