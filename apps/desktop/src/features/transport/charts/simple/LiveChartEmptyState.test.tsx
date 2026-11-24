import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

const flags = vi.hoisted(() => ({ simpleLyricsEditor: true, chartSources: true, lyrics: true, networkSessions: true }));
vi.mock("@libretracks/shared/featureFlags", () => ({ FEATURE_FLAGS: flags }));
vi.mock("../../../telemetry/telemetry", () => ({ recordProductEvent: vi.fn() }));
vi.mock("../../../chartSources/useChartSourcesAvailable", () => ({
  useChartSourcesAvailable: () => false,
  chartSourcesAvailableNow: () => false,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useChartEditorStore } from "../chartEditorStore";
import { LiveChartPanel } from "../LiveChartPanel";

const region = {
  id: "song",
  name: "Gracia",
  startSeconds: 0,
  endSeconds: 40,
  transposeSemitones: 0,
  key: "C",
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
  chart: null,
} as SongRegionSummary;

const view = {
  id: "session",
  title: "Session",
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 40,
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  sectionMarkers: [{ id: "verse", name: "Verso", startSeconds: 0, kind: "verse" }],
  clips: [],
  tracks: [],
  projectRevision: 1,
} as unknown as SongView;

describe("lyrics panel without lyrics", () => {
  it("C6: offers Write lyrics (simple editor) and Import", () => {
    render(
      <LiveChartPanel
        song={view}
        region={region}
        positionSecondsRef={{ current: 0 }}
        pendingMarkerId={null}
        expanded={false}
        onToggleExpanded={vi.fn()}
        onClose={vi.fn()}
        onChartChange={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByRole("button", { name: /liveChart\.importFile/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /simpleLyrics\.write/ }));
    expect(useChartEditorStore.getState().session?.initialMode).toBe("simple");
  });
});
