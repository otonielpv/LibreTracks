import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultTrackEq } from "@libretracks/shared/eq/trackEqModel";
import type { TrackEq, TrackSummary } from "@libretracks/shared/models";

import {
  RemoteEqButton,
  RemoteTrackEqHost,
  createRemoteEqHandlers,
  remoteSpectrumFeed,
  useRemoteEqStore,
} from "./remoteEq";

const track = (id: string, kind: TrackSummary["kind"], eq: TrackEq | null = null) =>
  ({ id, name: id.toUpperCase(), kind, eq }) as unknown as TrackSummary;

// jsdom no tiene PointerEvent: un MouseEvent con pointerId hace de puntero.
function pointer(target: Element, type: string, clientX: number, clientY: number) {
  const event = new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}

let frames: Array<() => void> = [];
const fakeFrames = {
  request: (callback: () => void) => {
    frames.push(callback);
    return frames.length;
  },
  cancel: () => {
    frames = [];
  },
};

beforeEach(() => {
  frames = [];
  useRemoteEqStore.setState({ openTrackId: null });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(() => callback(0));
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("remote EQ", () => {
  it("live sends are limited to one per frame and the commit carries the final curve", () => {
    const send = vi.fn();
    const local = vi.fn();
    const handlers = createRemoteEqHandlers(send, local, fakeFrames);
    const eq = defaultTrackEq();
    for (let gain = 1; gain <= 5; gain += 1) {
      eq.bands[2].gainDb = gain;
      handlers.applyLive("t1", { ...eq, bands: eq.bands.map((band) => ({ ...band })) });
    }
    expect(send).not.toHaveBeenCalled();
    frames.splice(0).forEach((callback) => callback());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].cmd).toBe("updateTrackEqLive");
    expect(send.mock.calls[0][0].eq.bands[2].gainDb).toBe(5);

    handlers.applyLive("t1", eq);
    void handlers.commit("t1", eq);
    frames.splice(0).forEach((callback) => callback());
    expect(send.mock.calls.map((call) => call[0].cmd)).toEqual(["updateTrackEqLive", "commitTrackEq"]);
    expect(local).toHaveBeenCalledWith("t1", eq);
  });

  it("the strip button opens the shared editor and releasing a node sends a commit", () => {
    const send = vi.fn();
    const tracks = [track("voz", "audio", defaultTrackEq()), track("luces", "midi")];
    render(
      <>
        {tracks.map((item) => (
          <RemoteEqButton key={item.id} track={item} language="es" />
        ))}
        <RemoteTrackEqHost tracks={tracks} send={send} onLocalCommit={vi.fn()} language="es" />
      </>,
    );
    // Audio y carpetas, no MIDI.
    expect(screen.queryByRole("button", { name: "Ecualizador de LUCES" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ecualizador de VOZ" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    const node = screen.getByTestId("lt-eq-node-3");
    pointer(node, "pointerdown", 300, 110);
    pointer(node, "pointermove", 360, 60);
    pointer(node, "pointerup", 360, 60);
    const commits = send.mock.calls.filter((call) => call[0].cmd === "commitTrackEq");
    expect(commits).toHaveLength(1);
    expect(commits[0][0].trackId).toBe("voz");
    expect(commits[0][0].eq.bands[2].gainDb).toBeGreaterThan(0);
  });

  it("the RTA asks the desktop for the track and only reads events of that track", async () => {
    const send = vi.fn();
    const handlers = createRemoteEqHandlers(send, vi.fn(), fakeFrames);
    handlers.startAnalyzer("voz");
    expect(send).toHaveBeenLastCalledWith({ cmd: "setTrackEqAnalyzer", trackId: "voz" });
    remoteSpectrumFeed.push({ trackId: "bajo", bands: [-10] });
    expect(await handlers.readSpectrum("voz")).toEqual([]);
    remoteSpectrumFeed.push({ trackId: "voz", bands: [-12, -24] });
    expect(await handlers.readSpectrum("voz")).toEqual([-12, -24]);
    handlers.stopAnalyzer();
    expect(send).toHaveBeenLastCalledWith({ cmd: "setTrackEqAnalyzer", trackId: null });
    expect(await handlers.readSpectrum("voz")).toEqual([]);
  });
});
