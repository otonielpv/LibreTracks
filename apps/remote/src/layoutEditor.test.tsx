import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { App } from "./App";
import { defaultLayout, serializeLayoutFile } from "./remoteLayout";

// App opens a WebSocket in useRemoteBridge; jsdom has none. Provide an inert
// stub so mounting doesn't throw. We never drive live data in these tests —
// they exercise the layout editor, which works with an empty song view.
class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = "";
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  // rAF is used by several widgets; make it a no-op that never schedules so the
  // test doesn't spin. Widgets render their initial state synchronously.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("layout editor", () => {
  it("renders the default layout's widgets on mount", () => {
    render(<App />);
    // The control deck (Vamp/Loop) and the mixer filter are part of the default
    // layout, so both must be present without entering edit mode.
    expect(screen.getByText("Vamp / Loop")).toBeTruthy();
  });

  it("toggles edit mode and shows the palette", () => {
    render(<App />);
    const editButton = screen.getByRole("button", { name: /edit layout|editar layout/i });
    fireEvent.click(editButton);
    // The palette is a labelled group; adding buttons appear prefixed with "+".
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });
    expect(palette).toBeTruthy();
    // Every default widget now shows a drag handle (its label as a button).
    expect(within(palette).getAllByRole("button").length).toBeGreaterThan(5);
  });

  it("adds a widget from the palette and persists the layout", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const before = defaultLayout().widgets.length;
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });
    // Add another "Key" widget.
    const keyButtons = within(palette).getAllByRole("button", { name: /key|tonalidad/i });
    fireEvent.click(keyButtons[0]);

    const stored = JSON.parse(
      window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
    );
    expect(stored.widgets.length).toBe(before + 1);
  });

  it("reset restores the default layout after edits", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });
    fireEvent.click(within(palette).getAllByRole("button", { name: /key|tonalidad/i })[0]);
    expect(
      JSON.parse(window.localStorage.getItem("libretracks.remote.layout") ?? "{}").widgets.length,
    ).toBe(defaultLayout().widgets.length + 1);

    fireEvent.click(screen.getByRole("button", { name: /reset layout|restaurar layout/i }));
    // Reset clears storage; the next stored write would be the default. The
    // in-memory layout is back to default length.
    expect(window.localStorage.getItem("libretracks.remote.layout")).toBeNull();
  });

  it("song-header and clip-list widgets are available in the palette and mount", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });

    // Both new widgets are offered.
    const songHeader = within(palette).getAllByRole("button", {
      name: /song header|cabecera de canción/i,
    });
    const clipList = within(palette).getAllByRole("button", {
      name: /clip list|lista de clips/i,
    });
    expect(songHeader.length).toBeGreaterThan(0);
    expect(clipList.length).toBeGreaterThan(0);

    // Adding the clip list mounts it; with no song view it shows the empty
    // "no active song" state rather than throwing.
    fireEvent.click(clipList[0]);
    expect(screen.getAllByText(/no active song|sin canción activa/i).length).toBeGreaterThan(0);
  });

  it("imports a layout file and persists it", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    // A layout file with just two widgets, carried from "another device".
    const incoming = {
      version: 1,
      widgets: [
        { id: "x", type: "timeline" as const, w: 6, h: 1 },
        { id: "y", type: "currentKey" as const, w: 1, h: 1 },
      ],
    };
    const fileText = serializeLayoutFile(incoming);
    const file = new File([fileText], "layout.json", { type: "application/json" });
    // jsdom's File may not implement text(); the browser does. Provide it so the
    // import handler's `await file.text()` resolves in the test environment.
    if (typeof file.text !== "function") {
      Object.defineProperty(file, "text", {
        value: () => Promise.resolve(fileText),
        configurable: true,
      });
    }

    const input = document.querySelector(
      "input.layout-import-input",
    ) as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);

    // The import reads the file asynchronously (file.text()) then persists;
    // wait until localStorage reflects the imported two-widget layout.
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
      );
      expect(stored.widgets?.map((w: { type: string }) => w.type)).toEqual([
        "timeline",
        "currentKey",
      ]);
    });
  });
});
