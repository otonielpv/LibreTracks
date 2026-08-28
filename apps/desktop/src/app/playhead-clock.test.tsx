import {
  act,
  fireEvent,
  screen,
  waitFor,
  en,
  textMatcher,
  useTransportStore,
  renderApp,
  mockRulerBounds,
  mockLaneBounds,
  mockTimelineShellMetrics,
  getTrackLaneRow,
} from "../test/testUtils";

/** Reads the timecode readout ("mm:ss.mmm") as seconds. */
function readoutSeconds(container: HTMLElement) {
  const label = container.querySelector(
    ".lt-readout-block.is-timecode strong",
  )?.textContent;
  expect(label).toBeTruthy();
  const [minutes, seconds] = (label as string).split(":");
  return Number(minutes) * 60 + Number(seconds);
}

describe("App / playhead-clock", () => {
  it("resyncs the visual clock to the backend while playing", async () => {
    const { container } = await renderApp();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: textMatcher(en.timelineTopbar.play),
        }),
      );
    });
    await waitFor(() => {
      expect(useTransportStore.getState().playback?.playbackState).toBe(
        "playing",
      );
    });

    // The backend clock stays at 0 here (the same shape as a stalled engine:
    // starvation, a dead device on the null pump). The visual playhead
    // extrapolates from performance.now(), so without a resync it free-runs
    // away from the transport forever — every 250ms poll carries the truth,
    // but they all report the same signature and the store drops them as
    // duplicates, so the drift correction never gets to see one.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 900);
      });
    });

    expect(useTransportStore.getState().playback?.positionSeconds).toBe(0);
    expect(readoutSeconds(container)).toBeLessThan(0.5);
  });
  it("leaves a held seek preview alone while polls keep arriving", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTimelineShellMetrics(container, 1500);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: textMatcher(en.timelineTopbar.play),
        }),
      );
    });
    await waitFor(() => {
      expect(useTransportStore.getState().playback?.playbackState).toBe(
        "playing",
      );
    });

    // Grab a clip and HOLD it: previewSeek pins the cursor at the grab point
    // for as long as the button is down. Polls keep landing during the hold,
    // and the drift correction must not read any of them as licence to drag
    // the playhead back to the engine position — the preview owns the cursor.
    const drumsLane = getTrackLaneRow(container, "Drums")?.querySelector(
      ".lt-track-lane",
    ) as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(drumsLane as HTMLElement, {
        button: 0,
        clientX: 320,
        clientY: 140,
      });
    });

    const previewedSeconds = readoutSeconds(container);
    expect(previewedSeconds).toBeGreaterThan(1);

    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 600);
      });
    });

    expect(readoutSeconds(container)).toBe(previewedSeconds);

    await act(async () => {
      fireEvent.mouseUp(window, { button: 0, clientX: 320, clientY: 140 });
    });
  });
});
