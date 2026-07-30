import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { App } from "./App";
import { defaultLayout, serializeLayoutFile, type RemoteLayout } from "./remoteLayout";

/** Total widget count across every tab of the persisted layout. */
function storedWidgetCount(): number {
  const stored = JSON.parse(
    window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
  ) as Partial<RemoteLayout>;
  return (stored.tabs ?? []).reduce((sum, tab) => sum + (tab.widgets?.length ?? 0), 0);
}

/** Widget count in the default layout (single tab). */
function defaultWidgetCount(): number {
  return defaultLayout().tabs.reduce((sum, tab) => sum + tab.widgets.length, 0);
}

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
  vi.restoreAllMocks();
});

describe("layout editor", () => {
  it("renders the default layout's widgets on mount", () => {
    render(<App />);
    // The control deck (Vamp/Loop) and the mixer filter are part of the default
    // layout, so both must be present without entering edit mode.
    expect(screen.getByText("Vamp / Loop")).toBeTruthy();
  });

  it("opens control configuration in a floating layer outside the widget", () => {
    render(<App />);
    const configButtons = screen.getAllByRole("button", { name: /settings|config/i });
    fireEvent.click(configButtons[0]);

    expect(screen.getByRole("dialog", { name: /settings|config/i })).toBeTruthy();
    const layer = document.querySelector(".remote-floating-panel-layer");
    expect(layer).not.toBeNull();
    expect(layer?.querySelector(".remote-inline-panel.is-floating")).not.toBeNull();

    fireEvent.pointerDown(layer!);
    expect(screen.queryByRole("dialog", { name: /settings|config/i })).toBeNull();
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
    // Three ways to resize, because dragging a grip is the part that fails on
    // a touch screen: per-axis ± steppers, single-axis edge grips and the
    // both-axes corner grip.
    expect(screen.getAllByRole("group", { name: /width|ancho/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("group", { name: /height|alto/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /resize width|redimensionar ancho/i }).length)
      .toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /resize height|redimensionar alto/i }).length)
      .toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /resize widget|redimensionar widget/i }).length)
      .toBeGreaterThan(0);
  });

  it("resizes a widget one cell per tap from the chrome steppers", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const readWidth = (index: number) => {
      const stored = JSON.parse(
        window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
      ) as Partial<RemoteLayout>;
      return stored.tabs?.[0]?.widgets?.[index]?.w;
    };

    // The first default widget spans the full grid, so it can only shrink.
    const narrower = screen.getAllByRole("button", { name: /narrower|más estrecho/i })[0];
    fireEvent.click(narrower);
    expect(readWidth(0)).toBe(23);

    const taller = screen.getAllByRole("button", { name: /^(?:taller|más alto):/i })[0];
    const before = JSON.parse(
      window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
    ) as Partial<RemoteLayout>;
    const heightBefore = before.tabs?.[0]?.widgets?.[0]?.h ?? 0;
    fireEvent.click(taller);
    const after = JSON.parse(
      window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
    ) as Partial<RemoteLayout>;
    expect(after.tabs?.[0]?.widgets?.[0]?.h).toBe(heightBefore + 1);
  });

  it("makes the tab strip taller and persists the choice", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    fireEvent.click(screen.getByRole("button", { name: /taller tabs|pestañas más altas/i }));
    const stored = JSON.parse(
      window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
    ) as Partial<RemoteLayout>;
    expect(stored.tabHeightRem).toBeCloseTo(2.2);
    // The height drives the tab chrome through a CSS variable on the tablist.
    expect(screen.getByRole("tablist").getAttribute("style")).toContain("--tab-height");
  });

  it("keeps the edit actions in the header, not in a bar over the tabs", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    // The toolbar used to float below the header, where it covered the tab
    // strip on a tablet. It must now be a child of the header itself.
    const done = screen.getByRole("button", { name: /^✓/ });
    const toolbar = done.closest(".layout-edit-toolbar");
    expect(toolbar).toBeTruthy();
    expect(toolbar?.closest("header.remote-header")).toBeTruthy();
    // The placement toggle and tab-height stepper moved in with it.
    expect(toolbar?.querySelector("[role='switch']")).toBeTruthy();
    expect(toolbar?.querySelector(".layout-tab-height")).toBeTruthy();
  });

  it("toggles the placement mode between free and push", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    const stored = JSON.parse(
      window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
    ) as Partial<RemoteLayout>;
    expect(stored.placementMode).toBe("push");
  });

  it("organizes every palette widget into labelled categories", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });

    for (const category of [
      /information|información/i,
      /^transport|transporte$/i,
      /live control|control en directo/i,
      /songs|canciones/i,
      /^mixer$|^mezclador$/i,
      /tools|herramientas/i,
      /^layout$|^diseño$/i,
    ]) {
      expect(within(palette).getByRole("heading", { name: category })).toBeTruthy();
    }

    expect(palette.querySelectorAll(".layout-palette-item").length).toBeGreaterThan(0);
    expect(palette.querySelectorAll(".layout-palette-category").length).toBe(7);
  });

  it("can hide and restore the floating widget palette", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    fireEvent.click(screen.getByRole("button", { name: /hide widgets|ocultar widgets/i }));
    expect(screen.queryByRole("group", { name: /add widget|añadir widget/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /show widgets|mostrar widgets/i }));
    expect(screen.getByRole("group", { name: /add widget|añadir widget/i })).toBeTruthy();
  });

  it("adds a widget from the palette and persists the layout", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const before = defaultWidgetCount();
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });
    // Add another "Key" widget.
    const keyButtons = within(palette).getAllByRole("button", { name: /key|tonalidad/i });
    fireEvent.click(keyButtons[0]);

    expect(storedWidgetCount()).toBe(before + 1);
    const stored = JSON.parse(
      window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
    ) as Partial<RemoteLayout>;
    expect(stored.customized).toBe(true);
  });

  it("push mode displaces the widgets below when one grows", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    fireEvent.click(screen.getByRole("switch"));

    const readTab = () => {
      const stored = JSON.parse(
        window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
      ) as Partial<RemoteLayout>;
      return stored.tabs?.[0]?.widgets ?? [];
    };

    // The default Controls tab is a full-width stack, so growing the first
    // widget must push every widget under it down by the same amount.
    const before = readTab().map((widget) => widget.y);
    fireEvent.click(screen.getAllByRole("button", { name: /^(?:taller|más alto):/i })[0]);
    const after = readTab().map((widget) => widget.y);

    expect(after[0]).toBe(before[0]);
    for (let index = 1; index < before.length; index += 1) {
      expect(after[index]).toBe(before[index] + 1);
    }
  });

  // NOTE: the trash zone arms on pointer COORDINATES, and jsdom ships no
  // PointerEvent — testing-library's pointer events therefore carry no
  // clientX/clientY, so the arming itself cannot be driven here. The geometry
  // check lives in rectContainsPoint (see remoteLayout.test.ts); what this test
  // pins down is that the zone is mounted only while a drag is in flight.
  it("mounts the trash zone only while a drag is in flight", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const trashQuery = () =>
      screen.queryByRole("button", { name: /drop to remove|suelta para quitar/i });

    // At rest there is no trash target covering the canvas.
    expect(trashQuery()).toBeNull();

    const grid = document.querySelector(".layout-canvas") as HTMLElement;
    const mover = screen.getAllByRole("button", { name: /move widget|mover widget/i })[0];
    fireEvent.pointerDown(mover, { pointerId: 1 });
    expect(trashQuery()).toBeTruthy();

    fireEvent.pointerUp(grid, { pointerId: 1 });
    expect(trashQuery()).toBeNull();
  });

  it("free mode leaves the other widgets where they are", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const readTab = () => {
      const stored = JSON.parse(
        window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
      ) as Partial<RemoteLayout>;
      return stored.tabs?.[0]?.widgets ?? [];
    };

    fireEvent.click(screen.getAllByRole("button", { name: /^(?:taller|más alto):/i })[0]);
    const after = readTab();
    // Default (free) placement: the grown widget now overlaps its neighbour and
    // nothing moved — that is the opt-in the push toggle exists for.
    expect(after[1].y).toBe(defaultLayout().tabs[0].widgets[1].y);
  });

  it("reset restores the default layout after edits", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });
    fireEvent.click(within(palette).getAllByRole("button", { name: /key|tonalidad/i })[0]);
    expect(storedWidgetCount()).toBe(defaultWidgetCount() + 1);

    fireEvent.click(screen.getByRole("button", { name: /reset layout|restaurar layout/i }));
    // Reset clears storage; the next stored write would be the default. The
    // in-memory layout is back to default length.
    expect(window.localStorage.getItem("libretracks.remote.layout")).toBeNull();
  });

  it("offers one fused compact-song widget and mounts it", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });

    const compactView = within(palette).getAllByRole("button", {
      name: /compact song view|vista compacta de canciones/i,
    });
    expect(compactView).toHaveLength(1);
    expect(within(palette).queryByRole("button", {
      name: /^\+ (clip list|lista de clips)$/i,
    })).toBeNull();

    // With no song view the combined widget shows its empty state.
    fireEvent.click(compactView[0]);
    expect(screen.getAllByText(/no active song|sin canción activa/i).length).toBeGreaterThan(0);
  });

  it("drag-adds a widget from the palette via pointer (down on item, up on grid)", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const before = storedWidgetCount() || defaultWidgetCount();
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });
    const keyItem = within(palette).getAllByRole("button", { name: /key|tonalidad/i })[0];

    // Pointer add-drag: down on the palette item starts it; up on the grid ends
    // it and inserts the widget at the resolved cell.
    fireEvent.pointerDown(keyItem, { pointerId: 1 });
    fireEvent.pointerUp(document.querySelector(".layout-canvas")!, { pointerId: 1 });

    expect(storedWidgetCount()).toBe(before + 1);
  });

  it("Cancel reverts changes made during the edit session", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    const before = defaultWidgetCount();
    // Make a change (add a widget from the palette via keyboard fallback).
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });
    fireEvent.click(within(palette).getAllByRole("button", { name: /key|tonalidad/i })[0]);
    expect(storedWidgetCount()).toBe(before + 1);

    // Cancel restores the pre-edit layout and persists it.
    fireEvent.click(screen.getByRole("button", { name: /^cancel$|^cancelar$/i }));
    expect(storedWidgetCount()).toBe(before);
    // And leaves edit mode (no palette shown).
    expect(screen.queryByRole("group", { name: /add widget|añadir widget/i })).toBeNull();
  });

  it("offers the split atomic widgets in the palette and they mount", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });

    // A representative atomic from each split: a single readout, a single
    // transport button, and a deck section.
    for (const name of [/^\+ time$|^\+ tiempo$/i, /^\+ play$|^\+ reproducir$/i, /vamp \/ loop/i]) {
      expect(within(palette).getAllByRole("button", { name }).length).toBeGreaterThan(0);
    }

    // Adding the BPM readout mounts it (shows the "BPM" label tile).
    const bpmItem = within(palette).getAllByRole("button", { name: /^\+ bpm$/i })[0];
    fireEvent.click(bpmItem);
    // The tile renders a BPM label somewhere on the canvas now.
    expect(screen.getAllByText(/^bpm$/i).length).toBeGreaterThan(0);
  });

  it("offers the mixer filter, song master and faders as separate widgets", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });

    for (const name of [
      /current song filter|filtro de canción actual/i,
      /song master|master de canción/i,
      /mixer faders|faders del mezclador/i,
    ]) {
      expect(within(palette).getAllByRole("button", { name }).length).toBeGreaterThan(0);
    }
  });

  it("offers metronome and voice guide settings as independent widgets", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });

    expect(within(palette).getByRole("button", {
      name: /metronome settings|configuración del metrónomo/i,
    })).toBeTruthy();
    expect(within(palette).getByRole("button", {
      name: /voice guide settings|configuración de la guía/i,
    })).toBeTruthy();
    expect(within(palette).queryByRole("button", {
      name: /^\+ (click and guide|click y guía)$/i,
    })).toBeNull();
  });

  it("offers a resizeable visual separator in the layout category", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });

    const separator = within(palette).getByRole("button", {
      name: /^\+ (separator|separador)$/i,
    });
    fireEvent.click(separator);

    expect(document.querySelector(".layout-separator")).not.toBeNull();
  });

  it("adds and configures the design widgets per instance", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));
    const palette = screen.getByRole("group", { name: /add widget|añadir widget/i });

    for (const name of [
      /section title|título de sección/i,
      /^\+ (note|nota)$/i,
      /widget group|grupo de widgets/i,
      /blank space|espacio en blanco/i,
    ]) {
      expect(within(palette).getByRole("button", { name })).toBeTruthy();
    }

    fireEvent.click(within(palette).getByRole("button", {
      name: /^\+ (widget group|grupo de widgets)$/i,
    }));
    expect(document.querySelector(".layout-design-group")).not.toBeNull();

    fireEvent.click(within(palette).getByRole("button", {
      name: /^\+ (section title|título de sección)$/i,
    }));
    const configureButtons = screen.getAllByRole("button", { name: /^configure$|^configurar$/i });
    fireEvent.click(configureButtons[configureButtons.length - 1]);

    const dialog = screen.getByRole("dialog", {
      name: /section title|título de sección/i,
    });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Escena acústica" } });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "center" } });

    const stored = JSON.parse(
      window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
    ) as RemoteLayout;
    const title = stored.tabs.flatMap((tab) => tab.widgets)
      .find((widget) => widget.type === "layoutTitle");
    expect(title?.config).toEqual({ text: "Escena acústica", align: "center" });
  });

  it("imports a layout file and persists it", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    // A v2 tabbed layout file (no x/y) carried from "another device"; the
    // importer migrates it to the current x/y model.
    const fileText = JSON.stringify({
      kind: "libretracks.remote.layout",
      version: 2,
      layout: {
        version: 2,
        activeTabId: "t1",
        tabs: [
          { id: "t1", name: "Live", widgets: [{ id: "x", type: "timeline", w: 6, h: 1 }] },
          { id: "t2", name: "Mixer", widgets: [{ id: "y", type: "mixer", w: 6, h: 2 }] },
        ],
      },
    });
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
    // wait until localStorage reflects the imported two-tab layout.
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
      );
      expect(stored.tabs?.map((t: { name: string }) => t.name)).toEqual(["Live", "Mixer"]);
    });
  });

  it("adds a new tab and switches to it", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    // The default has controls, mixer and performance tools.
    const initial = screen.getAllByRole("tab").length;
    expect(initial).toBe(3);

    fireEvent.click(screen.getByRole("button", { name: /\+ (tab|pestaña)/i }));

    // One more tab now, and the new one is persisted + active.
    expect(screen.getAllByRole("tab").length).toBe(initial + 1);
    const stored = JSON.parse(
      window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
    );
    expect(stored.tabs.length).toBe(initial + 1);
    expect(stored.activeTabId).toBe(stored.tabs[stored.tabs.length - 1].id);
  });

  it("reorders tabs with the move buttons", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /edit layout|editar layout/i }));

    // Default order (before any persistence): Controles, Mixer, Herramientas.
    const names = () => screen.getAllByRole("tab").map((el) => el.textContent);
    expect(names()).toEqual(["Controles", "Mixer", "Herramientas"]);

    // Move the second tab (Mixer) left; index 0's move-left is disabled.
    const moveLeft = screen.getAllByRole("button", {
      name: /move tab left|mover pestaña a la izquierda/i,
    });
    fireEvent.click(moveLeft[1]);

    // Order swapped in the UI and persisted.
    expect(names()).toEqual(["Mixer", "Controles", "Herramientas"]);
    const stored = JSON.parse(
      window.localStorage.getItem("libretracks.remote.layout") ?? "{}",
    );
    expect(stored.tabs.map((t: { name: string }) => t.name)).toEqual([
      "Mixer",
      "Controles",
      "Herramientas",
    ]);
  });
});
