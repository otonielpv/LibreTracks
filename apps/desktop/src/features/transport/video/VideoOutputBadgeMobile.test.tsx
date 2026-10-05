import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isTauriApp: false,
  isMobileApp: true,
}));

const live = vi.hoisted(() => ({ runVideoLiveAction: vi.fn(async () => undefined) }));
vi.mock("./videoLive", () => live);

import i18n from "../../../shared/i18n";
import type { SongView, VideoOutputStatus } from "../desktopApi";
import { useSongStore } from "../songStore";
import { VideoOutputBadge } from "./VideoOutputBadge";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

function status(state: VideoOutputStatus["state"], extra: Partial<VideoOutputStatus> = {}): VideoOutputStatus {
  return {
    state,
    visibleSlot: "a",
    players: [] as unknown as VideoOutputStatus["players"],
    brightness: 0,
    sharesAppDisplay: false,
    monitorName: "HDMI",
    opens: 1,
    dualPlayers: true,
    ...extra,
  };
}

const STATES: VideoOutputStatus["state"][] = [
  { state: "disabled" },
  { state: "standby" },
  { state: "noDisplay" },
  { state: "ready" },
  { state: "suspended" },
  { state: "displayLost" },
  { state: "unavailable", detail: "VideoOutputBridge no está" },
  { state: "error", detail: "códec no soportado" },
];

beforeEach(async () => {
  live.runVideoLiveAction.mockClear();
  useVideoStore.setState(INITIAL_VIDEO_STATE);
  useSongStore.setState({ song: { videoClips: [{ id: "v1" }] } as unknown as SongView });
  await i18n.changeLanguage("es");
});

/** Plan video-mobile, paso 10 C3. */
describe("the phone's video badge", () => {
  it("keeps the same two-icon slot in every state, so the top bar never shifts", () => {
    const { container } = render(<VideoOutputBadge />);
    for (const state of STATES) {
      act(() => useVideoStore.getState().setOutputStatus(status(state)));
      const slot = container.querySelector(".lt-video-output-mobile")!;
      expect(slot, state.state).not.toBeNull();
      const buttons = slot.querySelectorAll(":scope > button");
      expect(buttons.length, state.state).toBe(2);
      // Icons only: no text label that would widen the slot.
      for (const button of buttons) {
        expect(button.children.length).toBe(1);
        expect(button.firstElementChild!.classList.contains("material-symbols-outlined")).toBe(true);
      }
    }
  });

  it("offers black at one tap only while the output shows something", () => {
    render(<VideoOutputBadge />);
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "noDisplay" })));
    const black = () => screen.getByRole("button", { pressed: false });
    expect(black().hasAttribute("disabled")).toBe(true);
    expect(black().classList.contains("is-idle")).toBe(true);

    act(() => useVideoStore.getState().setOutputStatus(status({ state: "ready" })));
    expect(black().hasAttribute("disabled")).toBe(false);
    fireEvent.click(black());
    expect(live.runVideoLiveAction).toHaveBeenCalledWith("black");

    act(() => useVideoStore.getState().setForcedBlack(true));
    expect(screen.getByRole("button", { pressed: true }).getAttribute("aria-label")).toBe("Quitar el negro");
  });

  it("opens the full state on a tap: display, players and the lock hint", () => {
    render(<VideoOutputBadge />);
    act(() =>
      useVideoStore.getState().setOutputStatus(
        status({ state: "suspended" }, { dualPlayers: false, playersNote: "Un solo reproductor: los saltos…" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "proyector apagado por el bloqueo del móvil" }));
    const sheet = screen.getByRole("dialog");
    expect(sheet.textContent).toContain("HDMI");
    expect(sheet.textContent).toContain("Desbloquea para recuperarlo");
    expect(sheet.textContent).toContain("Un solo reproductor");
  });

  it("is not there when the session has no video", () => {
    useSongStore.setState({ song: { videoClips: [] } as unknown as SongView });
    const { container } = render(<VideoOutputBadge />);
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "ready" })));
    expect(container.textContent).toBe("");
  });
});
