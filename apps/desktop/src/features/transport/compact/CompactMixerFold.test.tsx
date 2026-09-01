import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TrackSummary } from "../desktopApi";
import { CompactMixer } from "./CompactMixer";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "trackHeader.expand") return `Expandir ${options?.name}`;
      if (key === "trackHeader.collapse") return `Colapsar ${options?.name}`;
      if (key === "trackHeader.hiddenCount") {
        return `${options?.count} pistas ocultas`;
      }
      return key;
    },
  }),
}));

const baseTrack = {
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
  transposeEnabled: false,
  audioTo: "master",
  color: null,
} as unknown as TrackSummary;

const track = (id: string, parentTrackId: string | null = null) =>
  ({ ...baseTrack, id, name: id, kind: "audio", parentTrackId }) as TrackSummary;

const folder = (id: string, parentTrackId: string | null = null) =>
  ({
    ...baseTrack,
    id,
    name: id,
    kind: "folder",
    parentTrackId,
  }) as TrackSummary;

const TRACKS = [folder("Banda"), track("voz", "Banda"), track("bateria")];

function renderMixer(
  overrides: {
    collapsedFolders?: Set<string>;
    onToggleFolder?: (trackId: string) => void;
    onTrackSelect?: () => void;
    onTrackDragStart?: () => void;
  } = {},
) {
  render(
    <CompactMixer
      tracks={TRACKS}
      audioRoutingOptions={[{ value: "master", label: "Master" }]}
      handlers={{
        onToggleMute: vi.fn(),
        onToggleSolo: vi.fn(),
        onToggleTranspose: vi.fn(),
        onVolumeChange: vi.fn(),
        onCommitVolume: vi.fn(),
        onPanChange: vi.fn(),
        onCommitPan: vi.fn(),
        onAudioToChange: vi.fn(),
      }}
      onTrackContextMenu={vi.fn()}
      selectedTrackIds={[]}
      onTrackSelect={overrides.onTrackSelect ?? vi.fn()}
      onTrackDragStart={overrides.onTrackDragStart ?? vi.fn()}
      activeSongTrackIds={null}
      filterActiveSong={false}
      collapsedFolders={overrides.collapsedFolders ?? new Set()}
      onToggleFolder={overrides.onToggleFolder ?? vi.fn()}
    />,
  );
}

const stripFor = (trackId: string) =>
  document.querySelector(`[data-track-id="${trackId}"]`) as HTMLElement;

describe("CompactMixer folder folding", () => {
  it("puts a fold control only on folder strips", () => {
    renderMixer();

    expect(
      within(stripFor("Banda")).getByRole("button", { name: "Colapsar Banda" }),
    ).toBeTruthy();
    expect(
      within(stripFor("voz")).queryByRole("button", { name: /Colapsar|Expandir/ }),
    ).toBeNull();
  });

  it("folds on click and reports which folder was clicked", () => {
    const onToggleFolder = vi.fn();
    renderMixer({ onToggleFolder });

    fireEvent.click(screen.getByRole("button", { name: "Colapsar Banda" }));

    expect(onToggleFolder).toHaveBeenCalledWith("Banda");
  });

  // The control states expanded vs folded through aria-expanded, so the label
  // and the icon are not the only thing carrying it.
  it("states the current fold state on the control", () => {
    renderMixer({ collapsedFolders: new Set(["Banda"]) });

    const control = screen.getByRole("button", { name: "Expandir Banda" });
    expect(control.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows how many strips a folded folder is hiding", () => {
    renderMixer({ collapsedFolders: new Set(["Banda"]) });

    expect(screen.getByText("1 pistas ocultas")).toBeTruthy();
    expect(stripFor("voz")).toBeNull();
  });

  it("unfolds from the hidden-count line too, not just the chevron", () => {
    const onToggleFolder = vi.fn();
    renderMixer({ collapsedFolders: new Set(["Banda"]), onToggleFolder });

    fireEvent.click(screen.getByText("1 pistas ocultas"));

    expect(onToggleFolder).toHaveBeenCalledWith("Banda");
  });

  // The regression this guards: the fold control sits inside the strip's name
  // band, which is also the reorder drag handle and the selection target. Only
  // stopPropagation keeps pressing the chevron from arming a track drag or
  // selecting the folder instead of folding it.
  it("does not select or start a drag when the fold control is pressed", () => {
    const onTrackSelect = vi.fn();
    const onTrackDragStart = vi.fn();
    renderMixer({ onTrackSelect, onTrackDragStart });

    const control = screen.getByRole("button", { name: "Colapsar Banda" });
    fireEvent.mouseDown(control, { button: 0 });
    fireEvent.click(control, { button: 0 });

    expect(onTrackDragStart).not.toHaveBeenCalled();
    expect(onTrackSelect).not.toHaveBeenCalled();
  });

  it("still selects and drags from the folder name itself", () => {
    const onTrackSelect = vi.fn();
    const onTrackDragStart = vi.fn();
    renderMixer({ onTrackSelect, onTrackDragStart });

    const name = within(stripFor("Banda")).getByText("Banda");
    fireEvent.mouseDown(name, { button: 0 });
    fireEvent.click(name, { button: 0 });

    expect(onTrackDragStart).toHaveBeenCalled();
    expect(onTrackSelect).toHaveBeenCalled();
  });
});
