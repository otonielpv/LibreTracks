import { beforeEach, describe, expect, it } from "vitest";

import type { RhythmLibrary } from "@libretracks/shared/models";

import { setRhythmLibraryForTest } from "../../../app/testDesktopApiMock";
import { act, fireEvent, render, screen, waitFor } from "../../../test/testUtils";
import { assignLoopToSong, saveLoopPattern } from "../desktopApi";
import { useBackDismissStore } from "../mobile/backNavigation";
import { RhythmDock, RhythmViewButton } from "./RhythmDock";
import { useRhythmStore } from "./rhythmStore";

const EMPTY: RhythmLibrary = { kits: [], patterns: [], oneShots: { banks: [] } };

beforeEach(() => setRhythmLibraryForTest(EMPTY));

// Decisión del usuario (2026-11-18): nunca a pantalla completa; en el
// teléfono también acoplado abajo, con el transporte a la vista.
describe("RhythmDock in the four views", () => {
  it.each([
    ["daw", "wide", "docked"],
    ["live", "wide", "docked"],
    ["compact", "medium", "docked"],
    ["daw", "short", "docked"],
    ["live", "short", "docked"],
    ["compact", "short", "docked"],
    ["setlist", "short", "docked"],
  ] as const)("%s at %s opens the %s variant from its button", async (view, layout, variant) => {
    render(
      <>
        <RhythmViewButton view={view} />
        <RhythmDock view={view} layoutClass={layout} />
      </>,
    );
    expect(screen.queryByTestId("rhythm-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("rhythm-button"));
    const panel = await screen.findByTestId("rhythm-panel");
    expect(panel.dataset.variant).toBe(variant);
    expect(screen.getByTestId("rhythm-button").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("rhythm-panel")).toBeNull();
  });

  it("the setlist tab is always open with the tab variant and no close button", async () => {
    render(<RhythmDock view="setlist" alwaysOpen layoutClass="wide" />);
    const panel = await screen.findByTestId("rhythm-panel");
    expect(panel.dataset.variant).toBe("tab");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("each view keeps its own open state", () => {
    useRhythmStore.getState().setOpen("live", true);
    expect(useRhythmStore.getState().openByView).toEqual({ daw: false, setlist: false, compact: false, live: true });
  });

  it("Android back closes only the sheet", async () => {
    let otherClosed = false;
    useBackDismissStore.getState().register({ id: "other-overlay", close: () => (otherClosed = true) });
    render(<RhythmDock view="daw" layoutClass="short" />);
    act(() => useRhythmStore.getState().setOpen("daw", true));
    await screen.findByTestId("rhythm-panel");
    // The sheet registers with the back guard in an effect, a tick after it shows.
    await waitFor(() => expect(useBackDismissStore.getState().stack.length).toBe(2));
    const stack = useBackDismissStore.getState().stack;
    // El guardián de atrás cierra lo último abierto: la hoja.
    act(() => stack[stack.length - 1].close());
    expect(screen.queryByTestId("rhythm-panel")).toBeNull();
    expect(otherClosed).toBe(false);
    expect(useBackDismissStore.getState().stack.map((e) => e.id)).toEqual(["other-overlay"]);
    useBackDismissStore.getState().unregister("other-overlay");
  });
});

describe("RhythmDock editors", () => {
  it("✎ opens the pattern editor on the active pattern and saving calls the commands", async () => {
    setRhythmLibraryForTest({
      kits: [
        {
          id: "kit",
          name: "Kit",
          sounds: [{ id: "hat", name: "Hat", color: "", sample: { source: { kind: "builtin" }, file: "hat.wav" }, gainDb: 0 }],
        },
      ],
      patterns: [],
      oneShots: { banks: [] },
    });
    render(<RhythmDock view="daw" layoutClass="wide" songRegionId="r1" />);
    act(() => useRhythmStore.getState().setOpen("daw", true));
    await screen.findByTestId("rhythm-panel");
    await waitFor(() => expect(useRhythmStore.getState().library?.kits).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByTestId("loop-editor")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save ▾" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Save to library" }));
    });
    expect(saveLoopPattern).toHaveBeenCalledWith(expect.objectContaining({ kit: { kind: "library", kitId: "kit" } }));
    fireEvent.click(screen.getByRole("button", { name: "Save ▾" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Assign to this song" }));
    });
    expect(assignLoopToSong).toHaveBeenCalledWith("r1", expect.objectContaining({ name: "Kit" }));
  });
});
