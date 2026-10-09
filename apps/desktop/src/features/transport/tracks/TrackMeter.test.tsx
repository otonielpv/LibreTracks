import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useTransportStore } from "../store";
import { TrackMeter, channelPeaks } from "./TrackMeter";

function channels(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".lt-track-meter-channel")].map(
    (channel) => ({
      bar: channel.querySelector<HTMLElement>(".lt-track-meter-bar")!,
      clip: channel.querySelector<HTMLElement>(".lt-track-meter-clip")!,
    }),
  );
}

describe("channelPeaks", () => {
  it("keeps left and right apart instead of folding them into one peak", () => {
    expect(channelPeaks({ leftPeak: 0.9, rightPeak: 0.1 })).toEqual([0.9, 0.1]);
  });
});

describe("TrackMeter", () => {
  beforeEach(() => {
    useTransportStore.setState({ meters: {} });
  });

  it("draws one bar per channel", () => {
    useTransportStore.setState({
      meters: { drums: { leftPeak: 0.8, rightPeak: 0 } },
    });
    const { container } = render(<TrackMeter trackId="drums" />);

    const [left, right] = channels(container);
    expect(channels(container)).toHaveLength(2);
    // A panned-left signal fills the left bar and leaves the right one empty.
    expect(left.bar.style.clipPath).not.toBe(right.bar.style.clipPath);
  });

  it("lights the clip only on the channel that clips", async () => {
    const { container } = render(<TrackMeter trackId="drums" />);

    act(() => {
      useTransportStore.setState({
        meters: { drums: { leftPeak: 1.2, rightPeak: 0.1 } },
      });
    });

    const [left, right] = channels(container);
    await waitFor(() => expect(left.clip.style.opacity).toBe("1"));
    expect(right.clip.style.opacity).toBe("0");
  });
});
