import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
  useTransportStore,
  renderApp,
  mockRulerBounds,
  mockLaneBounds,
} from "../test/testUtils";

// Open the global track-list menu by right-clicking the empty area of the
// track-headers pane (below the last header), then add the automation track.
async function addAutomationTrackViaMenu() {
  const pane = document.querySelector(".lt-track-headers-pane") as HTMLElement;
  expect(pane).toBeTruthy();
  await act(async () => {
    fireEvent.contextMenu(pane, { clientX: 80, clientY: 600 });
  });
  const addButton = await screen.findByRole("button", {
    name: /añadir pista de automatismos/i,
  });
  await act(async () => {
    fireEvent.click(addButton);
  });
}

describe("App / automation-track", () => {
  it("shows the automation lane header after adding the track", async () => {
    await renderApp();
    await addAutomationTrackViaMenu();

    await waitFor(() => {
      expect(
        document.querySelector(".lt-track-header.is-automation"),
      ).toBeTruthy();
    });
    // The synthetic lane row is painted in the track list, not the ruler.
    expect(
      document.querySelector(".lt-track-lane.is-automation"),
    ).toBeTruthy();
  });

  it("moves the playhead when the automation lane is clicked", async () => {
    const { container } = await renderApp();
    await addAutomationTrackViaMenu();
    await waitFor(() => {
      expect(
        document.querySelector(".lt-track-lane.is-automation"),
      ).toBeTruthy();
    });
    mockRulerBounds(container);
    mockLaneBounds(container);

    const lane = document.querySelector(
      ".lt-track-lane.is-automation",
    ) as HTMLElement;
    expect(lane).toBeTruthy();

    const before = useTransportStore.getState().playback?.positionSeconds ?? 0;
    await act(async () => {
      fireEvent.mouseDown(lane, { button: 0, clientX: 420, clientY: 130 });
      fireEvent.mouseUp(lane, { button: 0, clientX: 420, clientY: 130 });
    });

    // The seek path runs through the same handler as a normal lane; the
    // playhead position should have moved away from its starting point.
    await waitFor(() => {
      const after =
        useTransportStore.getState().playback?.positionSeconds ?? 0;
      expect(after).not.toBe(before);
    });
  });

  it("renders a cue hotspot in the lane after creating one", async () => {
    await renderApp();
    await addAutomationTrackViaMenu();
    await waitFor(() => {
      expect(
        document.querySelector(".lt-track-lane.is-automation"),
      ).toBeTruthy();
    });

    const lane = document.querySelector(
      ".lt-track-lane.is-automation",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.contextMenu(lane, { clientX: 300, clientY: 130 });
    });

    const createButton = await screen.findByRole("button", {
      name: /Crear automatismo/i,
    });
    await act(async () => {
      fireEvent.click(createButton);
    });

    // The visual editor modal opens seeded with a default destination; confirm.
    const dialog = await screen.findByRole("dialog", {
      name: /nuevo automatismo/i,
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /crear/i }));
    });

    // A cue hotspot button now exists inside the automation lane, giving the
    // visual feedback that the cue was created.
    await waitFor(() => {
      const cueButtons = document.querySelectorAll(
        ".lt-track-lane.is-automation .lt-automation-hotspot",
      );
      expect(cueButtons.length).toBeGreaterThan(0);
    });
  });

  it("opens the editor when the cue diamond is left-clicked", async () => {
    await renderApp();
    await addAutomationTrackViaMenu();
    await waitFor(() => {
      expect(
        document.querySelector(".lt-track-lane.is-automation"),
      ).toBeTruthy();
    });

    // Create a cue first.
    const lane = document.querySelector(
      ".lt-track-lane.is-automation",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.contextMenu(lane, { clientX: 300, clientY: 130 });
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", {
          name: /Crear automatismo/i,
        }),
      );
    });
    const createDialog = await screen.findByRole("dialog", {
      name: /nuevo automatismo/i,
    });
    await act(async () => {
      fireEvent.click(
        within(createDialog).getByRole("button", { name: /crear/i }),
      );
    });

    const hotspot = await waitFor(() => {
      const button = document.querySelector(
        ".lt-track-lane.is-automation .lt-automation-hotspot",
      );
      expect(button).toBeTruthy();
      return button as HTMLElement;
    });

    // Left-click the diamond → the editor opens (no right-click needed).
    await act(async () => {
      fireEvent.click(hotspot);
    });
    expect(
      await screen.findByRole("dialog", { name: /editar automatismo/i }),
    ).toBeTruthy();
  });

  it("creates a mix scene from the automation track menu", async () => {
    await renderApp();
    await addAutomationTrackViaMenu();

    const header = await waitFor(() => {
      const el = document.querySelector(".lt-track-header.is-automation");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });

    // Open the automation track menu and the scene manager.
    await act(async () => {
      fireEvent.contextMenu(header, { clientX: 60, clientY: 200 });
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", {
          name: /gestionar escenas de mezcla/i,
        }),
      );
    });

    const dialog = await screen.findByRole("dialog", {
      name: /escenas de mezcla/i,
    });

    // No scenes yet → create one.
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: /nueva escena/i }),
      );
    });

    // The new scene's name field appears in the detail pane.
    await waitFor(() => {
      expect(within(dialog).getByDisplayValue(/escena 1/i)).toBeTruthy();
    });
  });

  it("stores a repeat limit on the cue", async () => {
    await renderApp();
    await addAutomationTrackViaMenu();
    await waitFor(() => {
      expect(
        document.querySelector(".lt-track-lane.is-automation"),
      ).toBeTruthy();
    });

    const lane = document.querySelector(
      ".lt-track-lane.is-automation",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.contextMenu(lane, { clientX: 300, clientY: 130 });
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", {
          name: /Crear automatismo/i,
        }),
      );
    });
    const dialog = await screen.findByRole("dialog", {
      name: /nuevo automatismo/i,
    });

    // Enable the repeat limit and set it to 2.
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("checkbox", { name: /limitar repeticiones/i }),
      );
    });
    const vecesInput = within(dialog).getByRole("spinbutton", {
      name: /veces/i,
    });
    await act(async () => {
      fireEvent.change(vecesInput, { target: { value: "2" } });
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /crear/i }));
    });

    // The cue's tooltip reflects the limit ("2×").
    await waitFor(() => {
      const hotspot = document.querySelector(
        ".lt-track-lane.is-automation .lt-automation-hotspot",
      ) as HTMLElement | null;
      expect(hotspot?.getAttribute("title") ?? "").toContain("2×");
    });
  });

  it("builds a multi-action job in the cue editor", async () => {
    await renderApp();
    await addAutomationTrackViaMenu();
    await waitFor(() => {
      expect(
        document.querySelector(".lt-track-lane.is-automation"),
      ).toBeTruthy();
    });

    const lane = document.querySelector(
      ".lt-track-lane.is-automation",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.contextMenu(lane, { clientX: 300, clientY: 130 });
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", {
          name: /Crear automatismo/i,
        }),
      );
    });
    const dialog = await screen.findByRole("dialog", {
      name: /nuevo automatismo/i,
    });

    // The new cue seeds one jump action; add a mute and a wait → 3 actions.
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: /mute \/ unmute pista/i }),
      );
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: /^esperar$/i }),
      );
    });

    // Three action rows now exist (jump + mute + wait).
    expect(
      within(dialog).getAllByText(
        /saltar a…|mute \/ unmute pista|esperar/i,
      ).length,
    ).toBeGreaterThanOrEqual(3);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /crear/i }));
    });

    // The lane label/tooltip reflects a multi-action job ("+2" extra actions).
    await waitFor(() => {
      const hotspot = document.querySelector(
        ".lt-track-lane.is-automation .lt-automation-hotspot",
      ) as HTMLElement | null;
      expect(hotspot?.getAttribute("title") ?? "").toMatch(/Esperar|Mutear/i);
    });
  });
});
