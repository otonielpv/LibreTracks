// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import i18n from "../../../shared/i18n";

const api = vi.hoisted(() => ({
  commitSongMasterEqChange: vi.fn(async (_args: { regionId: string; eq: unknown }) => ({
    projectRevision: 21,
  })),
  updateSongMasterEqRealtime: vi.fn(async (_args: { regionId: string; eq: unknown }) => undefined),
}));

vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  commitSongMasterEqChange: api.commitSongMasterEqChange,
  updateSongMasterEqRealtime: api.updateSongMasterEqRealtime,
}));

import { getSong, setSong } from "../songStore";
import { SongMasterEqButton } from "./SongMasterEqButton";
import { TrackEqEditorHost } from "./TrackEqEditorHost";
import { useTrackEqStore } from "./trackEqStore";

beforeEach(async () => {
  await i18n.changeLanguage("es");
  vi.clearAllMocks();
  useTrackEqStore.setState({ openTrackId: null, targetTrackIds: [], openMasterRegionId: null });
  setSong({
    projectRevision: 1,
    tracks: [],
    regions: [
      { id: "r1", name: "Alfa", startSeconds: 0, endSeconds: 10, master: { gain: 1 } },
      { id: "r2", name: "Beta", startSeconds: 10, endSeconds: 20, master: { gain: 1 } },
    ],
  } as unknown as SongView);
});

afterEach(cleanup);

describe("song master EQ (plan track-eq-2, paso 09)", () => {
  it("the master popover button opens the editor and a commit reaches that song only", async () => {
    render(
      <>
        <SongMasterEqButton regionId="r1" />
        <TrackEqEditorHost
          runAction={async (action) => action()}
          applyPlaybackSnapshot={vi.fn()}
          optimisticallyAppliedRevisionsRef={{ current: new Set() }}
        />
      </>,
    );
    const button = screen.getByRole("button", { name: "Ecualizador del máster de Alfa" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Alfa")).toBeTruthy();

    const gain = within(dialog).getByLabelText("Ganancia de la banda 3");
    await act(async () => {
      fireEvent.change(gain, { target: { value: "4" } });
      fireEvent.keyDown(gain, { key: "Enter" });
    });
    expect(api.commitSongMasterEqChange).toHaveBeenCalledTimes(1);
    const { regionId, eq } = api.commitSongMasterEqChange.mock.calls[0][0] as {
      regionId: string;
      eq: { bands: { gainDb: number }[] };
    };
    expect(regionId).toBe("r1");
    expect(eq.bands[2].gainDb).toBe(4);
    const regions = getSong()!.regions;
    expect(regions[0].master.eq?.bands[2].gainDb).toBe(4);
    expect(regions[1].master.eq ?? null).toBeNull();
    // El botón se ilumina desde el modelo.
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});
