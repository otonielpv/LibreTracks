import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MixSceneSummary, TransportSnapshot } from "@libretracks/shared/models";

import { resetTestDesktopApiMock, testDesktopApiMock } from "../../../app/testDesktopApiMock";
import { useTransportStore } from "../store";
import { useMixSceneTriggerStore } from "./SceneButtons";
import { SceneBar } from "./SceneMenuButton";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The scenes fold into a button only in the mobile app.
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: true,
}));

const scene = (id: string, name: string): MixSceneSummary => ({ id, name, rampSeconds: 0, rules: [] });

function publish(snapshot: TransportSnapshot) {
  act(() => useTransportStore.getState().setPlaybackState(snapshot));
}

/** A phone matches the Live view's phone query; a tablet does not. */
function screenIs(phone: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: phone, addEventListener: () => {}, removeEventListener: () => {} }),
  });
}

describe("SceneBar", () => {
  const original = window.matchMedia;

  beforeEach(async () => {
    resetTestDesktopApiMock();
    await testDesktopApiMock.upsertMixScene(scene("down", "Banda baja"));
    publish(await testDesktopApiMock.upsertMixScene(scene("piano", "Solo piano")));
    useMixSceneTriggerStore.setState({
      trigger: (sceneId, mode) => void testDesktopApiMock.triggerMixScene(sceneId, mode ?? "toggle").then(publish),
    });
  });

  afterEach(() => {
    useMixSceneTriggerStore.setState({ trigger: null });
    useTransportStore.getState().setPlaybackState(null);
    Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
  });

  it("on a phone the scenes fold into one button that opens them and lights while one is engaged", async () => {
    screenIs(true);
    render(<SceneBar className="row" menuClassName="rail" />);
    // The iPhone report: the row took a quarter of the mixer. Only the button now.
    expect(screen.queryByRole("button", { name: /Banda baja/ })).toBeNull();
    const menu = screen.getByRole("button", { name: /transport.mixScene.menuButton/ });
    expect(menu.className).toContain("rail");
    expect(menu.className).not.toContain("is-active");

    await act(async () => fireEvent.click(menu));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Banda baja/ })));
    expect(screen.getByRole("button", { name: /Banda baja/ }).getAttribute("aria-pressed")).toBe("true");
    expect(menu.className).toContain("is-active");
  });

  it("on a tablet the row stays", () => {
    screenIs(false);
    render(<SceneBar className="row" menuClassName="rail" />);
    expect(screen.getByRole("button", { name: /Banda baja/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /transport.mixScene.menuButton/ })).toBeNull();
  });

  it("without scenes there is no button either", () => {
    screenIs(true);
    act(() => useTransportStore.getState().setPlaybackState(null));
    const { container } = render(<SceneBar />);
    expect(container.innerHTML).toBe("");
  });
});
