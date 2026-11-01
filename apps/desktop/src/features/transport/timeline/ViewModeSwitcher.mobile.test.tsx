import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ViewModeSwitcher } from "./ViewModeSwitcher";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The views fold into one menu button only in the mobile app.
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: true,
}));

describe("ViewModeSwitcher (mobile)", () => {
  it("shows one button with the current view instead of four", () => {
    render(<ViewModeSwitcher value="compact" onChange={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toBe("liveView.chooseView");
    expect(buttons[0].textContent).toContain("liveView.compact");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the four views in a menu and switches to the one picked", async () => {
    const onChange = vi.fn();
    render(<ViewModeSwitcher value="daw" onChange={onChange} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "liveView.chooseView" })));

    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "liveView.openDaw",
      "liveView.openSetlist",
      "liveView.openCompact",
      "liveView.open",
    ]);
    expect(items[0].getAttribute("aria-checked")).toBe("true");

    await act(async () => fireEvent.click(screen.getByRole("menuitemradio", { name: "liveView.openSetlist" })));
    expect(onChange).toHaveBeenCalledWith("setlist");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("picking the view already shown just closes the menu", async () => {
    const onChange = vi.fn();
    render(<ViewModeSwitcher value="live" onChange={onChange} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "liveView.chooseView" })));
    await act(async () => fireEvent.click(screen.getByRole("menuitemradio", { name: "liveView.open" })));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
