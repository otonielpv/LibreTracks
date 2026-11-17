import { describe, expect, it } from "vitest";

import type { RegionLoop } from "@libretracks/shared/models";

import { setRhythmSamplesForTest } from "../../../app/testDesktopApiMock";
import { fireEvent, render, screen, waitFor } from "../../../test/testUtils";
import { downloadRhythmPack } from "../desktopApi";
import { MissingPacksNotice } from "./MissingPacksNotice";

const songLoop: RegionLoop = {
  autostart: true,
  initialRows: [],
  pattern: {
    id: "p",
    name: "Latin",
    bpm: 100,
    signature: { numerator: 4, denominator: 4 },
    stepsPerBeat: 4,
    bars: 1,
    swing: 0,
    rows: [{ soundId: "guiro", gainDb: 0, variations: [] }],
    kit: {
      kind: "embedded",
      kit: {
        id: "latin",
        name: "Latin",
        sounds: [
          { id: "guiro", name: "Güiro", color: "", sample: { source: { kind: "pack", packId: "latin" }, file: "g.wav" }, gainDb: 0 },
          { id: "hat", name: "Hat", color: "", sample: { source: { kind: "builtin" }, file: "hat.wav" }, gainDb: 0 },
        ],
      },
    },
  },
};

describe("MissingPacksNotice", () => {
  it("keeps the song loop and offers to download a missing pack", async () => {
    setRhythmSamplesForTest([]);
    render(<MissingPacksNotice songLoop={songLoop} />);
    expect(await screen.findByText("Missing the latin pack: those rows stay silent.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(downloadRhythmPack).toHaveBeenCalledWith("latin"));
  });

  it("says nothing when the pack is installed", async () => {
    setRhythmSamplesForTest([{ sample: { source: { kind: "pack", packId: "latin" }, file: "g.wav" }, name: "g", bytes: 1 }]);
    const { container } = render(<MissingPacksNotice songLoop={songLoop} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("[data-testid='missing-packs']")).toBeNull();
  });
});
