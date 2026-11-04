import { describe, expect, it, vi } from "vitest";

vi.mock("./cloudFlows", () => ({
  exportAskingWhere: vi.fn(),
  finishExportWithChoice: vi.fn(),
}));

import { finishExportWithChoice } from "./cloudFlows";
import { confirmSessionExport } from "./exportWiring";

describe("confirmSessionExport", () => {
  it("names the set by its title alone, without the first song's tempo or meter", () => {
    // The project bpm/timeSignature belong to the first song only; a set of
    // songs at 70, 71 and 72 bpm must not be labelled `[70bpm 4-4]`.
    const session = { title: "Test", bpm: 70, timeSignature: "4/4" };
    confirmSessionExport(session, vi.fn(), vi.fn())("full");

    expect(vi.mocked(finishExportWithChoice)).toHaveBeenCalledWith("Test.ltset", expect.any(Function));
  });
});
