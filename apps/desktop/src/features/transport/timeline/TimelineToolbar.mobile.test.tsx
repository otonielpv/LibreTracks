import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlGroup } from "./TimelineToolbar";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("lt-mobile");
});

describe("ControlGroup on mobile", () => {
  it("portals its settings sheet outside the horizontally scrolling toolbar", () => {
    document.documentElement.classList.add("lt-mobile");
    const onToggleOpen = vi.fn();
    const { rerender } = render(
      <ControlGroup
        title="Vamp"
        open={false}
        onToggleOpen={onToggleOpen}
        details={<button type="button">Apply</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Vamp settings" }));
    expect(onToggleOpen).toHaveBeenCalledOnce();

    rerender(
      <ControlGroup
        title="Vamp"
        open
        onToggleOpen={onToggleOpen}
        details={<button type="button">Apply</button>}
      />,
    );

    const sheet = document.body.querySelector(
      ":scope > .lt-control-popover-portal [data-lt-control-popover-panel]",
    );
    expect(sheet).toBeTruthy();
    expect(sheet?.querySelector("button")?.textContent).toBe("Apply");
  });
});
