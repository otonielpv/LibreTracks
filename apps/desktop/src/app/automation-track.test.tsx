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
      name: /crear automatismo de salto/i,
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
});
