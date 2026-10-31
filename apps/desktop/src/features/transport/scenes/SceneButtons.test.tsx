import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MixSceneSummary, TransportSnapshot } from "@libretracks/shared/models";

import { resetTestDesktopApiMock, testDesktopApiMock } from "../../../app/testDesktopApiMock";
import { useTransportStore } from "../store";
import { useTimelineUIStore } from "../uiStore";
import { SceneButtons, useMixSceneTriggerStore } from "./SceneButtons";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const scene = (id: string, name: string): MixSceneSummary => ({
  id,
  name,
  rampSeconds: 0,
  rules: [],
});

function publish(snapshot: TransportSnapshot) {
  act(() => useTransportStore.getState().setPlaybackState(snapshot));
}

describe("SceneButtons", () => {
  beforeEach(async () => {
    resetTestDesktopApiMock();
    await testDesktopApiMock.upsertMixScene(scene("down", "Banda baja"));
    publish(await testDesktopApiMock.upsertMixScene(scene("piano", "Solo piano")));
  });

  afterEach(() => {
    useMixSceneTriggerStore.setState({ trigger: null });
    useTransportStore.getState().setPlaybackState(null);
    useTimelineUIStore.setState({ midiLearnMode: null });
  });

  it("a tap toggles the scene through the backend and lights it", async () => {
    const sent: string[] = [];
    useMixSceneTriggerStore.setState({
      trigger: (sceneId, mode) => {
        sent.push(`${sceneId}:${mode}`);
        void testDesktopApiMock.triggerMixScene(sceneId, mode ?? "toggle").then(publish);
      },
    });
    render(<SceneButtons />);
    const first = screen.getByRole("button", { name: /Banda baja/ });
    expect(first.getAttribute("aria-pressed")).toBe("false");

    await act(async () => fireEvent.click(first));
    expect(sent).toEqual(["down:toggle"]);
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Solo piano/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );

    await act(async () => fireEvent.click(first));
    expect(sent).toEqual(["down:toggle", "down:toggle"]);
    expect(first.getAttribute("aria-pressed")).toBe("false");
  });

  it("follows the snapshot when a cue or MIDI engages a scene", () => {
    render(<SceneButtons />);
    const current = useTransportStore.getState().playback!;
    publish({ ...current, activeMixSceneIds: ["piano"] });
    expect(screen.getByRole("button", { name: /Solo piano/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: /Banda baja/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("renders nothing without scenes", async () => {
    await testDesktopApiMock.deleteMixScene("down");
    publish(await testDesktopApiMock.deleteMixScene("piano"));
    const { container } = render(<SceneButtons />);
    expect(container.innerHTML).toBe("");
  });

  it("numbers the buttons in the editor order and tints them in MIDI Map mode", () => {
    useMixSceneTriggerStore.setState({ trigger: () => {} });
    render(<SceneButtons />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["1Banda baja", "2Solo piano"]);
    expect(buttons[0].className).not.toContain("lt-midi-mappable");

    act(() => useTimelineUIStore.setState({ midiLearnMode: "__map__" }));
    expect(screen.getAllByRole("button")[0].className).toContain("lt-midi-mappable");
  });
});
