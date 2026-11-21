import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TransportSnapshot } from "@libretracks/shared/models";

import { useTransportStore } from "../store";
import { FadeStopButton } from "./FadeStopButton";

const fadeOutAndStop = vi.fn();

vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return { ...actual, fadeOutAndStop: () => fadeOutAndStop() };
});

function playback(patch: Partial<TransportSnapshot>) {
  useTransportStore.setState({
    playback: { playbackState: "stopped", projectRevision: 1, ...patch } as TransportSnapshot,
  });
}

describe("FadeStopButton", () => {
  beforeEach(() => {
    fadeOutAndStop.mockReset().mockResolvedValue({});
  });

  it("is disabled while stopped with no song loaded", () => {
    playback({ playbackState: "stopped" });
    render(<FadeStopButton isProjectEmpty />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  // Stopped or paused it is «Fade in y reproducir»: same command, the backend
  // picks the direction. The icon and label say which one a press does.
  it.each(["stopped", "paused"] as const)("fades in when %s", (playbackState) => {
    playback({ playbackState });
    render(<FadeStopButton />);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("timelineTopbar.fadeInPlay");
    expect(button.textContent).toContain("trending_up");
    fireEvent.click(button);
    expect(fadeOutAndStop).toHaveBeenCalledTimes(1);
  });

  it("starts the fade while playing", () => {
    playback({ playbackState: "playing" });
    render(<FadeStopButton />);
    expect(screen.getByRole("button").textContent).toContain("trending_down");
    fireEvent.click(screen.getByRole("button"));
    expect(fadeOutAndStop).toHaveBeenCalledTimes(1);
  });

  // While it fades the button lights up and stays pressable: the second press
  // is the emergency stop.
  it("lights up during the fade and stays pressable", () => {
    playback({ playbackState: "playing", fadingToStop: true });
    render(<FadeStopButton />);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.classList.contains("is-active")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.disabled).toBe(false);
  });

  it("picks itself as the MIDI learn target in learn mode", () => {
    playback({ playbackState: "stopped" });
    const onMidiLearnTarget = vi.fn();
    render(<FadeStopButton learnModeActive onMidiLearnTarget={onMidiLearnTarget} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onMidiLearnTarget).toHaveBeenCalledWith("action:fade_out_stop");
    expect(fadeOutAndStop).not.toHaveBeenCalled();
  });
});
