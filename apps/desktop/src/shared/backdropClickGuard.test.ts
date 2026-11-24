import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBackdropClickGuard } from "./backdropClickGuard";

describe("installBackdropClickGuard", () => {
  let uninstall: () => void;
  let backdrop: HTMLDivElement;
  let input: HTMLInputElement;
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockReset();
    backdrop = document.createElement("div");
    backdrop.className = "lt-modal-backdrop lt-chart-import-backdrop";
    input = document.createElement("input");
    backdrop.appendChild(input);
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", onClose);
    uninstall = installBackdropClickGuard();
  });

  afterEach(() => {
    uninstall();
    backdrop.remove();
  });

  it("no cierra si la pulsacion empieza dentro y se suelta en el fondo", () => {
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cierra si la pulsacion empieza y acaba en el fondo", () => {
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deja pasar clics sinteticos sin pulsacion previa", () => {
    backdrop.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("no afecta a elementos que no son fondo", () => {
    const button = document.createElement("button");
    const span = document.createElement("span");
    button.appendChild(span);
    document.body.appendChild(button);
    const onButton = vi.fn();
    button.addEventListener("click", onButton);
    span.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onButton).toHaveBeenCalledTimes(1);
    button.remove();
  });
});
