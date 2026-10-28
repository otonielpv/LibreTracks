import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegionTempoControl } from "./RegionTempoControl";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("RegionTempoControl", () => {
  it("adds up quick clicks before the snapshot comes back", () => {
    const onChange = vi.fn();
    render(
      <RegionTempoControl
        currentBpm={120}
        originalBpm={120}
        disabled={false}
        onChange={onChange}
      />,
    );

    const up = screen.getByRole("button", { name: "timelineToolbar.regionTempoUpAria" });
    fireEvent.click(up);
    fireEvent.click(up);

    expect(onChange.mock.calls.map(([bpm]) => bpm)).toEqual([121, 122]);
  });

  it("goes back to the exact original BPM, not its rounded neighbour", () => {
    const onChange = vi.fn();
    render(
      <RegionTempoControl
        currentBpm={130}
        originalBpm={118.27}
        disabled={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "timelineToolbar.regionTempoResetAria" }),
    );

    expect(onChange).toHaveBeenCalledWith(118.27);
  });

  it("commits a typed tempo on Enter and clamps it to the engine range", () => {
    const onChange = vi.fn();
    render(
      <RegionTempoControl
        currentBpm={120}
        originalBpm={120}
        disabled={false}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole("textbox", { name: "timelineToolbar.regionTempoAria" });
    fireEvent.change(input, { target: { value: "96,5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange.mock.calls.map(([bpm]) => bpm)).toEqual([96.5, 300]);
  });
});
