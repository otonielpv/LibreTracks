import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SongRegionSummary } from "../desktopApi";
import { useSongColumnHandlers, type SongColumnHandlerSource } from "./useSongColumnHandlers";

const source = (): SongColumnHandlerSource => ({
  onMasterGainChange: vi.fn(),
  onMasterGainCommit: vi.fn(),
  onDropOsFilesIntoSong: vi.fn(),
  onDropLibraryAssetsIntoSong: vi.fn(),
  onPlaySong: vi.fn(),
  onRenameSong: vi.fn(),
  onSetSongBpm: vi.fn(),
  onDeleteSong: vi.fn(),
  onExportSong: vi.fn(),
  onSetSongKey: vi.fn(),
  onSelectRegion: vi.fn(),
});

const region = (id: string, name: string) => ({ id, name }) as SongRegionSummary;

describe("useSongColumnHandlers", () => {
  it("keeps each column's handlers identical across renders, so the memoized column skips them", () => {
    const { result, rerender } = renderHook(
      ({ handlers }) => useSongColumnHandlers(handlers, [region("a", "Uno")]),
      { initialProps: { handlers: source() } },
    );
    const first = result.current("a");
    rerender({ handlers: source() });
    expect(result.current("a")).toBe(first);
    expect(result.current("a").onPlay).toBe(first.onPlay);
  });

  it("calls the latest parent handler with the region id and the current name", () => {
    const initial = source();
    const { result, rerender } = renderHook(
      ({ handlers, regions }) => useSongColumnHandlers(handlers, regions),
      { initialProps: { handlers: initial, regions: [region("a", "Uno")] } },
    );
    const handlers = result.current("a");
    const latest = source();
    rerender({ handlers: latest, regions: [region("a", "Renombrada")] });

    handlers.onPlay();
    handlers.onMasterGainChange(0.5);
    handlers.onSelect();

    expect(initial.onPlaySong).not.toHaveBeenCalled();
    expect(latest.onPlaySong).toHaveBeenCalledWith("a", "Renombrada");
    expect(latest.onMasterGainChange).toHaveBeenCalledWith("a", 0.5);
    expect(latest.onSelectRegion).toHaveBeenCalledWith("a");
  });
});
