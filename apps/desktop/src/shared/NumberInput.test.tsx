import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NumberInput, parseNumberDraft } from "./NumberInput";

describe("NumberInput", () => {
  it("lets the field be emptied to type another number", () => {
    const onChange = vi.fn();
    render(<NumberInput aria-label="lead" min={0} value={1} onChange={onChange} />);
    const input = screen.getByLabelText("lead") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2.5" } });
    expect(onChange).toHaveBeenLastCalledWith(2.5);
  });

  it("restores the last value when left empty", () => {
    const onChange = vi.fn();
    render(<NumberInput aria-label="bars" integer min={1} value={4} onChange={onChange} />);
    const input = screen.getByLabelText("bars") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("4");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not clamp while typing, only on blur", () => {
    const onChange = vi.fn();
    render(<NumberInput aria-label="bpm" min={30} max={300} value={120} onChange={onChange} />);
    const input = screen.getByLabelText("bpm") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(30);
    expect(input.value).toBe("30");
  });

  it("reads a decimal comma", () => {
    expect(parseNumberDraft("2,5")).toBe(2.5);
    expect(parseNumberDraft("")).toBeNull();
    expect(parseNumberDraft("-")).toBeNull();
  });
});
