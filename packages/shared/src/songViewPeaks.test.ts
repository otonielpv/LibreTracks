// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]) => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { getSongView } from "./desktopApi";

// The song view used to carry every waveform of the session (base64). With a
// 120-stem setlist that one message killed the Android WebView renderer, and
// the app with it, each time a song was added (2026-11-17). Peaks come from
// get_waveform_summaries in small batches instead.
describe("getSongView", () => {
  it("never asks the backend for inline peaks", async () => {
    await getSongView();
    expect(invoke).toHaveBeenCalledWith("get_song_view", { includeWaveforms: false });
  });
});
