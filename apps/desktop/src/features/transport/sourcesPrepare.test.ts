import { describe, expect, it } from "vitest";
import type { SourceReadinessSummary } from "@libretracks/shared/models";
import {
  activateFromSources,
  deriveSourcesPreparing,
  nextSourcesPrepareUiState,
  SOURCES_PREPARE_INITIAL,
} from "./sourcesPrepare";

function sources(
  overrides: Partial<SourceReadinessSummary> = {},
): SourceReadinessSummary {
  return {
    sourcesReady: false,
    sourcesTotal: 0,
    sourcesReadyCount: 0,
    sourcesLoadingCount: 0,
    sourcesFailedCount: 0,
    sourcesProgressPercent: 0,
    cacheRamUsedMb: 0,
    cacheDiskUsedMb: 0,
    ...overrides,
  };
}

describe("deriveSourcesPreparing", () => {
  it("is false with no sources, null, or undefined", () => {
    expect(deriveSourcesPreparing(null)).toBe(false);
    expect(deriveSourcesPreparing(undefined)).toBe(false);
    expect(deriveSourcesPreparing(sources({ sourcesTotal: 0 }))).toBe(false);
  });

  it("is false when all sources are ready", () => {
    expect(
      deriveSourcesPreparing(sources({ sourcesTotal: 4, sourcesReady: true })),
    ).toBe(false);
  });

  it("is true while sources are still being prepared", () => {
    expect(
      deriveSourcesPreparing(
        sources({ sourcesTotal: 4, sourcesReady: false, sourcesReadyCount: 1 }),
      ),
    ).toBe(true);
  });
});

describe("nextSourcesPrepareUiState", () => {
  it("stays inactive while not yet shown (debounce owned by caller)", () => {
    const next = nextSourcesPrepareUiState(
      SOURCES_PREPARE_INITIAL,
      sources({ sourcesTotal: 8, sourcesReadyCount: 2, sourcesProgressPercent: 30 }),
    );
    // Visibility is decided by the show-delay timer, not this reducer.
    expect(next.active).toBe(false);
  });

  it("refreshes live numbers when already active", () => {
    const prev = { ...SOURCES_PREPARE_INITIAL, active: true };
    const next = nextSourcesPrepareUiState(
      prev,
      sources({
        sourcesTotal: 8,
        sourcesReadyCount: 5,
        sourcesProgressPercent: 62.5,
        sourcesFailedCount: 1,
      }),
    );
    expect(next).toEqual({
      active: true,
      percent: 62.5,
      readyCount: 5,
      total: 8,
      failedCount: 1,
    });
  });

  it("clamps the percent into 0..100", () => {
    const prev = { ...SOURCES_PREPARE_INITIAL, active: true };
    const over = nextSourcesPrepareUiState(
      prev,
      sources({ sourcesTotal: 2, sourcesProgressPercent: 140 }),
    );
    expect(over.percent).toBe(100);
    const under = nextSourcesPrepareUiState(
      prev,
      sources({ sourcesTotal: 2, sourcesProgressPercent: -5 }),
    );
    expect(under.percent).toBe(0);
  });

  it("clears active the moment sources become ready", () => {
    const prev = {
      active: true,
      percent: 80,
      readyCount: 7,
      total: 8,
      failedCount: 0,
    };
    const next = nextSourcesPrepareUiState(
      prev,
      sources({ sourcesTotal: 8, sourcesReady: true, sourcesReadyCount: 8 }),
    );
    expect(next.active).toBe(false);
  });
});

describe("activateFromSources (debounce fire)", () => {
  it("returns a visible state when still preparing", () => {
    const next = activateFromSources(
      sources({ sourcesTotal: 8, sourcesReadyCount: 3, sourcesProgressPercent: 42 }),
    );
    expect(next).toEqual({
      active: true,
      percent: 42,
      readyCount: 3,
      total: 8,
      failedCount: 0,
    });
  });

  it("returns null if preparation already finished before the timer fired", () => {
    expect(
      activateFromSources(sources({ sourcesTotal: 8, sourcesReady: true })),
    ).toBeNull();
    expect(activateFromSources(null)).toBeNull();
  });

  it("passes through the failed count without blocking visibility", () => {
    const next = activateFromSources(
      sources({ sourcesTotal: 4, sourcesReadyCount: 2, sourcesFailedCount: 1 }),
    );
    expect(next?.active).toBe(true);
    expect(next?.failedCount).toBe(1);
  });
});
