import { describe, expect, it, vi } from "vitest";

import { DB_FLOOR } from "@libretracks/shared/faderScale";

import { fireEvent, render, screen } from "../../../test/testUtils";
import { RhythmVolumeFader } from "./RhythmVolumeFader";

describe("RhythmVolumeFader", () => {
  it("is a console fader on the track dB scale with -inf at the bottom and reset on double click", () => {
    const onChange = vi.fn();
    render(<RhythmVolumeFader db={-6} ariaLabel="Volume" onChange={onChange} />);
    const fader = screen.getByRole("slider", { name: "Volume" });
    expect(fader.className).toContain("lt-fader");
    expect(fader.className).toContain("is-volume");
    expect(screen.getByText("-6.0")).toBeTruthy();
    // 0 dB a 3/4 del recorrido, con imán.
    fireEvent.change(fader, { target: { value: "0.76" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.change(fader, { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith(10);
    // El fondo se guarda finito (el JSON no admite −∞).
    fireEvent.change(fader, { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith(DB_FLOOR);
    fireEvent.doubleClick(fader);
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("reads -inf at the floor", () => {
    render(<RhythmVolumeFader db={DB_FLOOR} ariaLabel="Volume" onChange={() => {}} />);
    expect(screen.getByText("-inf")).toBeTruthy();
  });
});
