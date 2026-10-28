import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SideNav } from "./SideNav";
import { NavigationToggle } from "./NavigationToggle";
import { useTimelineUIStore } from "../uiStore";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../tutorial/TourLauncherButton", () => ({ TourLauncherButton: () => null }));

beforeEach(() => { localStorage.clear(); useTimelineUIStore.setState({ navigationCollapsed: false }); });
afterEach(cleanup);

it("hides the navigation, remembers it and lets the user restore it", () => {
  const props = {
    activeSidebarTab: null, isRemoteModalOpen: false, isSettingsModalOpen: false,
    onLibraryToggle: vi.fn(), onRemoteClick: vi.fn(), onSettingsClick: vi.fn(),
  };
  const view = render(<><NavigationToggle /><SideNav {...props} /></>);
  fireEvent.click(screen.getByRole("button", { name: "transport.shell.hideNavigation" }));
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(localStorage.getItem("lt-navigation-collapsed")).toBe("true");
  view.unmount();
  render(<><NavigationToggle /><SideNav {...props} /></>);
  fireEvent.click(screen.getByRole("button", { name: "transport.shell.showNavigation" }));
  expect(screen.getByRole("complementary")).toBeTruthy();
  expect(localStorage.getItem("lt-navigation-collapsed")).toBe("false");
});