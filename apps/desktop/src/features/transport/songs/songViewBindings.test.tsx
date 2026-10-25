import { render } from "@testing-library/react";
import { useState } from "react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { CompactView } from "../compact/CompactView";
import type { SongViewBindings } from "./songViewBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: false,
}));

vi.mock("../store", () => ({
  useTransportStore: (selector: (state: { optimisticRegionMaster: object }) => unknown) =>
    selector({ optimisticRegionMaster: {} }),
}));

vi.mock("../tracks/TrackMeter", () => ({
  SongMasterMeter: () => null,
  TrackMeter: () => null,
}));

vi.mock("../structure/ArrangementBadge", () => ({
  ArrangementBadge: () => null,
}));

// The mixer is a plain (non-memo) child of CompactView: it renders exactly
// when CompactView renders, which makes it the render counter.
const mixerRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../compact/CompactMixer", () => ({
  CompactMixer: () => {
    mixerRenders.count += 1;
    return null;
  },
}));

const region = {
  id: "song-1",
  name: "Cancion",
  startSeconds: 0,
  endSeconds: 60,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
};

const noop = () => {};

// Every field is created once, as the panel does with useMemo/useCallback
// and the stable factories.
const stableFields = {
  regions: [region],
  tracks: [],
  activeRegionId: null,
  pendingRegionId: null,
  clipsByRegion: { "song-1": [] },
  audioRoutingOptions: [],
  mixerHandlers: {
    onToggleMute: noop,
    onToggleSolo: noop,
    onToggleTranspose: noop,
    onVolumeChange: noop,
    onCommitVolume: noop,
    onPanChange: noop,
    onCommitPan: noop,
    onAudioToChange: noop,
  },
  onTrackContextMenu: noop,
  selectedTrackIds: [],
  onTrackSelect: noop,
  onTrackDragStart: noop,
  selectedRegionId: null,
  onSelectRegion: noop,
  collapsedFolders: new Set<string>(),
  onToggleFolder: noop,
  onMasterGainChange: noop,
  onMasterGainCommit: noop,
  onDropOsFilesIntoSong: noop,
  onDropLibraryAssetsIntoSong: noop,
  onMoveClipToTrack: noop,
  onDeleteClip: noop,
  onPlaySong: noop,
  onRenameSong: noop,
  onSetSongBpm: noop,
  onDeleteSong: noop,
  onExportSong: noop,
  onSetSongKey: noop,
  onReorderSong: noop,
  bpmByRegion: {},
  onSnapshotApplied: noop,
  onImportSongPackageFromDialog: noop,
  onImportSongPackageFromOsFile: noop,
} satisfies SongViewBindings;

/** Re-renders itself on demand, building a NEW bindings object each time
 * from `makeBindings`, the way TransportPanelContent does on every render. */
function renderWithParent(makeBindings: () => SongViewBindings) {
  let bump: () => void = noop;
  function Parent() {
    const [tick, setTick] = useState(0);
    bump = () => setTick(tick + 1);
    const songBindings = makeBindings();
    return (
      <CompactView
        {...songBindings}
        onSongColumnWidthChange={noop}
        dragPreview={null}
        compactMixerFilterActiveSong={false}
      />
    );
  }
  render(<Parent />);
  return () => act(() => bump());
}

describe("songBindings spread into a memo view", () => {
  it("a new container with the same fields does not re-render CompactView", () => {
    const rerenderParent = renderWithParent(() => ({ ...stableFields }));
    const initial = mixerRenders.count;
    expect(initial).toBeGreaterThan(0);

    rerenderParent();
    rerenderParent();

    expect(mixerRenders.count).toBe(initial);
  });

  it("an inline lambda in one field re-renders CompactView on every parent render", () => {
    // The failure the panel must avoid: this is what `onReorderSong={(id, i)
    // => runAction(...)}` used to do before the shared handlers.
    const rerenderParent = renderWithParent(() => ({
      ...stableFields,
      onReorderSong: (regionId: string, targetIndex: number) => {
        void regionId;
        void targetIndex;
      },
    }));
    const initial = mixerRenders.count;

    rerenderParent();
    rerenderParent();

    expect(mixerRenders.count).toBe(initial + 2);
  });
});
