import { act, render, screen, waitFor, App } from "../test/testUtils";
import { switchToDifferentSongForTest } from "./testDesktopApiMock";

// Regression test for the reported RAM-spike/audio-glitch bug: opening a
// second song within the same project session used to skip its own waveform
// fetch entirely, so the new song silently inherited the previous song's
// waveforms instead of requesting its own.
//
// Peaks never ride on the song view (a whole session's worth killed the
// Android WebView, 2026-11-17): useSongWaveforms asks for them in batches.
describe("App / waveform cache on song switch", () => {
  it("requests waveforms for a newly opened song instead of reusing the previous song's", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const getWaveformSummariesSpy = vi.mocked(desktopApi.getWaveformSummaries);

    await render(<App />);
    await screen.findByText(/ready|listo/i);

    // The initial load fetches the first song's peaks by key.
    await waitFor(() => {
      expect(getWaveformSummariesSpy).toHaveBeenCalled();
    });
    getWaveformSummariesSpy.mockClear();

    // Switch to a different song within the same session (backend bumps the
    // project revision).
    await act(async () => {
      switchToDifferentSongForTest("audio/second-song-track.wav", 90);
    });

    // The new song's own source is requested.
    await waitFor(
      () => {
        expect(getWaveformSummariesSpy).toHaveBeenCalledWith(
          expect.arrayContaining(["audio/second-song-track.wav"]),
        );
      },
      { timeout: 4000 },
    );
  });
});
