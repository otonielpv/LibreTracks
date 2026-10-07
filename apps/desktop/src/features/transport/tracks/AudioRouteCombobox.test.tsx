// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioRouteCombobox } from "./AudioRouteCombobox";

afterEach(cleanup);

const options = [
  { value: "master", label: "Master" },
  { value: "ext:0-1", label: "Out 1/2" },
];

describe("AudioRouteCombobox", () => {
  // A track that left its folder in an older session can still store
  // "inherit"; the engine plays it through Master, so that is what shows.
  it("shows an orphan inherit route as Master", () => {
    render(<AudioRouteCombobox value="inherit" options={options} ariaLabel="Audio To" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Audio To" }).textContent).toContain("Master");
    expect(screen.getByRole("button", { name: "Audio To" }).textContent).not.toContain("inherit");
  });

  it("keeps a real inherit option when the track is inside a folder", () => {
    render(
      <AudioRouteCombobox
        value="inherit"
        options={[{ value: "inherit", label: "Heredado (Carpeta)" }, ...options]}
        ariaLabel="Audio To"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Audio To" }).textContent).toContain("Heredado (Carpeta)");
  });
});
