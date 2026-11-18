import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DrumKit, LoopPattern, OneShotSet } from "@libretracks/shared/models";

import { failNextImportForTest, setRhythmSamplesForTest } from "../../../app/testDesktopApiMock";
import i18n from "../../../shared/i18n";
import { act, fireEvent, render, screen, waitFor, within } from "../../../test/testUtils";
import { importUserSample } from "../desktopApi";
import { blankKit, KitEditor, patternsUsingSound } from "./KitEditor";
import { OneShotPadEditor } from "./OneShotPadEditor";
import { ensureBank, renameBank, setPad, swapPads } from "./oneShotOps";
import type { RhythmLayoutClass } from "./useRhythmLayout";

const boom = {
  id: "boom",
  name: "Boom",
  color: "#ff8800",
  sample: { source: { kind: "builtin" as const }, file: "boom.wav" },
  gainDb: 0,
  mode: "oneShot" as const,
  quantize: "off" as const,
};

function set(): OneShotSet {
  return ensureBank({ banks: [] }, 1);
}

beforeEach(() => {
  setRhythmSamplesForTest([
    { sample: { source: { kind: "builtin" }, file: "boom.wav" }, name: "boom", bytes: 10 },
    { sample: { source: { kind: "pack", packId: "fx" }, file: "riser.wav" }, name: "riser", bytes: 10 },
  ]);
});

function renderPad(layout: RhythmLayoutClass = "wide", bankIndex = 1, padIndex = 2, initial = set()) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <OneShotPadEditor
      set={initial}
      bankIndex={bankIndex}
      padIndex={padIndex}
      layoutClass={layout}
      onSave={onSave}
      onClose={onClose}
      pickPath={async () => "C:/Música/mi riser.wav"}
    />,
  );
  return { onSave, onClose };
}

describe("one shot ops", () => {
  it("set, swap and rename keep twelve pads per bank", () => {
    let s = setPad(set(), 1, 0, boom);
    expect(s.banks[1].pads).toHaveLength(12);
    s = swapPads(s, 1, 0, 5);
    expect(s.banks[1].pads[0]).toBeNull();
    expect(s.banks[1].pads[5]?.id).toBe("boom");
    s = renameBank(s, 1, "FX");
    expect(s.banks[1].name).toBe("FX");
    expect(s.banks[0].pads.every((p) => p === null)).toBe(true);
  });
});

describe("OneShotPadEditor", () => {
  it("importing a sample adds it to My sounds and assigns it to the pad", async () => {
    const { onSave } = renderPad();
    fireEvent.click(screen.getByRole("button", { name: "Import file…" }));
    await waitFor(() => expect(importUserSample).toHaveBeenCalledWith("C:/Música/mi riser.wav", "oneShot"));
    const picker = (await screen.findByRole("combobox", { name: "Sample" })) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getByRole("group", { name: "My sounds" })).toBeTruthy());
    expect(picker.value).toBe("user/mi riser.wav");
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("mi riser");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    const saved: OneShotSet = onSave.mock.calls[0][0];
    expect(saved.banks[1].pads[2]?.sample).toEqual({ source: { kind: "user" }, file: "mi riser.wav" });
    expect(saved.banks[0].pads[2]).toBeNull();
  });

  it("limit errors are translated in English and Spanish", async () => {
    failNextImportForTest("sample too long: 40.0 s, limit 30 s");
    renderPad();
    fireEvent.click(screen.getByRole("button", { name: "Import file…" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This sample lasts 40.0 s and the limit is 30 s.");
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    failNextImportForTest("sample bank over memory limit: 120.0 MB > 96.0 MB");
    fireEvent.click(screen.getByRole("button", { name: "Importar archivo…" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Los sonidos ocupan 120.0 MB y el límite es 96.0 MB. Usa muestras más cortas o menos sonidos.",
      ),
    );
  });

  it("editing a pad saves the right bank", async () => {
    const { onSave } = renderPad("wide", 1, 4, setPad(set(), 1, 4, boom));
    fireEvent.change(screen.getByRole("combobox", { name: "Mode" }), { target: { value: "gate" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Quantize" }), { target: { value: "bar" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Bank name" }), { target: { value: "Efectos" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    const saved: OneShotSet = onSave.mock.calls[0][0];
    expect(saved.banks[1].pads[4]).toMatchObject({ id: "boom", mode: "gate", quantize: "bar" });
    expect(saved.banks[1].name).toBe("Efectos");
  });

  it.each([
    ["wide", "popover"],
    ["medium", "popover"],
    ["short", "sheet"],
  ] as const)("%s shows a %s", (layout, variant) => {
    renderPad(layout);
    expect(screen.getByTestId("pad-editor").dataset.variant).toBe(variant);
  });
});

describe("KitEditor", () => {
  const kit: DrumKit = {
    id: "basic",
    name: "Basic",
    sounds: [
      { id: "hat", name: "Hat", color: "", sample: { source: { kind: "builtin" }, file: "hat.wav" }, gainDb: 0 },
      { id: "tamb", name: "Tamb", color: "", sample: { source: { kind: "builtin" }, file: "tamb.wav" }, gainDb: 0 },
    ],
  };
  const pattern = (id: string, sounds: string[]): LoopPattern => ({
    id,
    name: id,
    kit: { kind: "library", kitId: "basic" },
    bpm: 100,
    signature: { numerator: 4, denominator: 4 },
    stepsPerBeat: 4,
    bars: 1,
    swing: 0,
    rows: sounds.map((soundId) => ({ soundId, gainDb: 0, variations: [] })),
  });
  const patterns = [pattern("a", ["hat", "tamb"]), pattern("b", ["hat"]), pattern("c", ["tamb"])];

  it("removing a used sound warns with the number of patterns", async () => {
    expect(patternsUsingSound(kit, "hat", patterns)).toBe(2);
    const confirm = vi.fn(() => false);
    const onSave = vi.fn();
    render(<KitEditor kit={kit} patterns={patterns} onSave={onSave} onClose={() => {}} confirm={confirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Hat" }));
    expect(confirm).toHaveBeenCalledWith("Hat is used by 2 patterns. Remove it anyway?");
    expect(screen.getByTestId("kit-sound-1")).toBeTruthy();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Hat" }));
    expect(screen.queryByTestId("kit-sound-1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add sound" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(onSave.mock.calls[0][0].sounds.map((s: { id: string }) => s.id)[0]).toBe("tamb");
    expect(onSave.mock.calls[0][0].sounds).toHaveLength(2);
  });

  it("«Save as new» keeps the original and saves a copy with a new id", async () => {
    const onSave = vi.fn();
    render(<KitEditor kit={kit} patterns={patterns} onSave={onSave} onClose={() => {}} newKitId={() => "copy-1"} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save as new" }));
    });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "copy-1", name: "Basic (copy)" }));
    expect(onSave.mock.calls[0][0].sounds.map((s: { id: string }) => s.id)).toEqual(["hat", "tamb"]);
  });

  it("a new kit has no «Save as new» and cannot be saved empty", () => {
    render(<KitEditor kit={blankKit("Mine", "k")} isNew patterns={[]} onSave={vi.fn()} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Save as new" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
