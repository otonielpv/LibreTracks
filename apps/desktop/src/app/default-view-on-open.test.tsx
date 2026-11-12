import { storeDefaultViewMode } from "../features/transport/defaultViewMode";
import { useTimelineUIStore } from "../features/transport/uiStore";
import {
  act,
  en,
  fireEvent,
  renderApp,
  screen,
  textMatcher,
  waitFor,
} from "../test/testUtils";

describe("App / startup view preference", () => {
  afterEach(() => window.localStorage.clear());

  it("opens a session in the view chosen in Settings, even if chosen after app start", async () => {
    await renderApp();
    expect(useTimelineUIStore.getState().viewMode).toBe("daw");

    // Chosen with the app already running, as a user would in Settings.
    storeDefaultViewMode("setlist");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.timelineTopbar.fileMenu) }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Open$/ }));
    });

    await waitFor(() => expect(useTimelineUIStore.getState().viewMode).toBe("setlist"));
  });
});
