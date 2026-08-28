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

async function seekRulerAt(container: HTMLElement, clientX: number) {
  const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
  await act(async () => {
    fireEvent.mouseDown(ruler, { button: 0, clientX });
  });
  await act(async () => {
    fireEvent.mouseUp(window, { button: 0, clientX });
  });
}

describe("App / timeline-seek", () => {
  it("keeps the playhead advancing after seeking twice to the same position", async () => {
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

    // Two clicks on the very same ruler pixel: the backend answers with an
    // identical snapshot (same lastSeekPositionSeconds), which the store's
    // publish gate drops. The visual anchor previewSeek() left frozen must
    // still be released, or the playhead stays pinned until the next click.
    await seekRulerAt(container, 320);
    await seekRulerAt(container, 320);

    const pinnedSeconds = readoutSeconds(container);
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
    });

    expect(readoutSeconds(container)).toBeGreaterThan(pinnedSeconds);
  });

  it("returns the playhead to the start when Home is pressed twice", async () => {
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

    const pressHome = async () => {
      await act(async () => {
        fireEvent.keyDown(window, { code: "Home", key: "Home" });
      });
    };

    // Two presses in a row: the second one seeks to a position the backend
    // already reports as its last seek, so its snapshot is deduped by the
    // store. The visual clock must still be re-anchored to 0.
    await pressHome();
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 120);
      });
    });
    await pressHome();

    expect(readoutSeconds(container)).toBeLessThan(0.05);
  });
});
