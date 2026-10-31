import {
  act,
  en,
  fireEvent,
  renderApp,
  screen,
  textMatcher,
} from "../test/testUtils";

describe("App / mix scenes from the File menu", () => {
  it("opens the scenes editor without an automation track", async () => {
    await renderApp();
    expect(document.getElementById("lt-scene-modal-title")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.timelineTopbar.fileMenu) }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: textMatcher(en.transport.menu.mixScenes) }));
    });

    expect(document.getElementById("lt-scene-modal-title")).not.toBeNull();
    // Nothing in the timeline asked for an automation lane.
    expect(screen.queryByText(en.transport.automation.removeTrack)).toBeNull();
  });
});
