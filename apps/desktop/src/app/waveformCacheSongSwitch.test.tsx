import { act, render, screen, waitFor, App } from "../test/testUtils";
import { switchToDifferentSongForTest } from "./testDesktopApiMock";

// Regression test for the reported RAM-spike/audio-glitch bug: opening a
// second song within the same project session used to skip its own waveform
// fetch entirely (waveformsHydratedRef never reset on a song switch), so the
// new song silently inherited the previous song's waveforms instead of
// requesting its own. See TransportPanelContent.tsx's `loadSong` effect.
describe("App / waveform cache on song switch", () => {
  it("requests waveforms for a newly opened song instead of reusing the previous song's", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const getSongViewSpy = vi.mocked(desktopApi.getSongView);

    await render(<App />);
    await screen.findByText(/ready|listo/i);

    // The initial load fetches the first song with its waveforms.
    await waitFor(() => {
      expect(getSongViewSpy).toHaveBeenCalledWith({ includeWaveforms: true });
    });
    getSongViewSpy.mockClear();

    // Switch to a different song within the same session (backend bumps the
    // project revision).
    await act(async () => {
      switchToDifferentSongForTest("audio/second-song-track.wav", 90);
    });

    // The fix: because the song id changed, the loader must re-fetch WITH
    // waveforms for the new song rather than skipping the fetch and inheriting
    // the previous song's waveforms. Without the fix, no such call is made
    // (needsWaveforms stays false for the whole session after the first song).
    await waitFor(
      () => {
        expect(getSongViewSpy).toHaveBeenCalledWith({ includeWaveforms: true });
      },
      { timeout: 4000 },
    );
  });
});
