import { vi } from "vitest";

import {
  act,
  en,
  fireEvent,
  renderApp,
  screen,
  textMatcher,
  within,
} from "../test/testUtils";

async function openSetlist() {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const view = await renderApp();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: textMatcher(en.liveView.openSetlist) }),
    );
  });
  return view;
}

describe("App / Setlist view", () => {
  it("shows one card per song of the session", async () => {
    const { container } = await openSetlist();
    expect(screen.getByRole("main", { name: textMatcher(en.setlistView.title) })).toBeTruthy();
    const cards = container.querySelectorAll(".lt-setlist-song-tile");
    expect(cards.length).toBeGreaterThan(0);
    expect(container.querySelector(".lt-ruler-canvas-layer")).toBeNull();
  });

  it("a card's menu is the DAW song menu", async () => {
    const { container } = await openSetlist();
    const card = container.querySelector<HTMLElement>(".lt-setlist-song-tile")!;
    await act(async () => {
      fireEvent.contextMenu(card);
    });
    const rename = await screen.findByRole("button", {
      name: textMatcher(en.transport.menu.renameSong),
    });
    const menu = rename.closest(".lt-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(
      within(menu).getByRole("button", { name: textMatcher(en.transport.menu.deleteSong) }),
    ).toBeTruthy();
  });
});
