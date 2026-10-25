import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ViewModeSwitcher } from "./ViewModeSwitcher";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ViewModeSwitcher", () => {
  it("offers four views with Setlist second", () => {
    render(<ViewModeSwitcher value="daw" onChange={() => {}} />);
    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "liveView.openDaw",
      "liveView.openSetlist",
      "liveView.openCompact",
      "liveView.open",
    ]);
  });

  it("marks Setlist as pressed when active and switches to it", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ViewModeSwitcher value="daw" onChange={onChange} />,
    );
    const setlist = screen.getByRole("button", { name: "liveView.openSetlist" });
    expect(setlist.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(setlist);
    expect(onChange).toHaveBeenCalledWith("setlist");

    rerender(<ViewModeSwitcher value="setlist" onChange={onChange} />);
    expect(
      screen
        .getByRole("button", { name: "liveView.openSetlist" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
