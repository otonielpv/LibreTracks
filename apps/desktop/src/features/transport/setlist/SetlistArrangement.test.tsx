import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongRegionSummary, SongView } from "@libretracks/shared/models";

import { useSongStore } from "../songStore";
import { SongStructurePanel } from "../structure/SongStructurePanel";
import type { StructureHandlers } from "../structure/structureHandlers";
import { INITIAL_STRUCTURE_STATE, useStructureStore } from "../structure/structureStore";
import { updateDraft, duplicateBlock } from "../structure/structureEditor";
import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, requestEditMode, useSetlistStore } from "./setlistStore";
import { testRegion, testSetlistProps } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));
vi.mock("../tracks/TrackMeter", () => ({ SongMasterMeter: () => null, TrackMeter: () => null }));
vi.mock("../structure/ArrangementBadge", () => ({ ArrangementBadge: () => null }));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: false,
}));
const dialog = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => false) }));
vi.mock("../../../shared/dialog/dialogService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/dialog/dialogService")>()),
  confirmDialog: dialog.confirmDialog,
}));

const section = (markerId: string, startSeconds: number, endSeconds: number) => ({
  markerId,
  name: markerId,
  kind: "verse" as const,
  variant: null,
  color: null,
  implicit: false,
  startSeconds,
  endSeconds,
  bars: (endSeconds - startSeconds) / 2,
});

const region = testRegion("r1", {
  name: "Canción",
  startSeconds: 0,
  endSeconds: 60,
  structure: {
    sections: [section("Verso", 0, 20), section("Coro", 20, 60)],
    arrangements: [{ id: "corto", name: "Corto", blocks: [{ id: "b1", sectionMarkerId: "Coro" }] }],
    appliedArrangementId: null,
  },
}) as SongRegionSummary;
const marker = (id: string, startSeconds: number) =>
  ({ id, name: id, startSeconds, kind: "verse" }) as SectionMarkerSummary;

function handlers(): StructureHandlers {
  return {
    applyArrangement: vi.fn(async () => ({ ok: true, error: null })),
    saveArrangement: vi.fn(async () => ({ ok: true, error: null })),
    deleteArrangement: vi.fn(async () => undefined),
    captureOriginal: vi.fn(async () => undefined),
    editOriginal: vi.fn(async () => undefined),
    snapSectionToBar: vi.fn(async () => undefined),
  } as unknown as StructureHandlers;
}

function props(structureHandlers = handlers(), markers = [marker("Verso", 0), marker("Coro", 20)]) {
  const base = testSetlistProps({ regions: [region], sectionMarkers: markers } as Partial<SongView>);
  useSongStore.setState({ song: base.performance.song });
  return { ...base, selectedRegionId: "r1", structureHandlers };
}

beforeEach(() => {
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useStructureStore.setState(INITIAL_STRUCTURE_STATE);
  dialog.confirmDialog.mockReset();
  dialog.confirmDialog.mockResolvedValue(false);
});

describe("Arrangement outside edit", () => {
  it("the map's picker applies the chosen arrangement through applyArrangement", () => {
    const base = props();
    render(<SetlistView {...base} layoutClass="wide" />);
    fireEvent.change(screen.getByRole("combobox", { name: "transport.structure.selector" }), {
      target: { value: "corto" },
    });
    expect(base.structureHandlers.applyArrangement).toHaveBeenCalledWith("r1", "corto", "Corto");
  });

  it("after an arrangement is applied the map follows the snapshot's markers", () => {
    // The arrangement is written on the timeline: the snapshot brings the
    // markers in their new order (Coro first).
    const { container } = render(
      <SetlistView {...props(handlers(), [marker("Coro", 0), marker("Verso", 40)])} layoutClass="wide" />,
    );
    const order = Array.from(container.querySelectorAll(".lt-setlist-map-block")).map((element) =>
      element.getAttribute("data-block-id"),
    );
    expect(order).toEqual(["Coro", "Verso"]);
  });
});

describe("Edit → Arrangement", () => {
  it.each([
    ["wide", "is-horizontal"],
    ["medium", "is-horizontal"],
    ["short", "is-row"],
  ] as const)("%s shows SongStructureEditor %s", async (layoutClass, editorClass) => {
    const { container } = render(<SetlistView {...props()} layoutClass={layoutClass} />);
    await act(async () => {
      await requestEditMode("arrangement");
    });
    expect(container.querySelector(`.lt-structure-editor.${editorClass}`)).not.toBeNull();
    // Embedded: the app's own panel stays hidden.
    expect(useStructureStore.getState().editorHost).toBe("embedded");
  });

  it("the DAW's arrangement panel does not show while embedded", () => {
    useSongStore.setState({ song: { regions: [region] } as unknown as SongView });
    useStructureStore.setState({ editorRegionId: "r1", editorHost: "embedded" });
    const { container } = render(<SongStructurePanel handlers={handlers()} variant="desktop" />);
    expect(container.querySelector(".lt-structure-panel")).toBeNull();
  });

  it("leaving with unapplied changes asks, and stays when the answer is no", async () => {
    render(<SetlistView {...props()} layoutClass="wide" />);
    await act(async () => {
      await requestEditMode("arrangement");
    });
    const draft = useStructureStore.getState().draft!;
    act(() => updateDraft((current) => duplicateBlock(current, draft.blocks[0].id)));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "setlistView.edit.done" }));
    });
    expect(dialog.confirmDialog).toHaveBeenCalledWith("transport.structure.closeWithChanges");
    expect(useSetlistStore.getState().editMode).toBe("arrangement");

    dialog.confirmDialog.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "setlistView.edit.modes.song" }));
    });
    expect(useSetlistStore.getState().editMode).toBe("song");
    expect(useStructureStore.getState().editorRegionId).toBeNull();
    expect(useStructureStore.getState().editorHost).toBe("panel");
  });

  it("Apply saves and applies the working copy with the panel's action", async () => {
    const base = props();
    render(<SetlistView {...base} layoutClass="wide" />);
    await act(async () => {
      await requestEditMode("arrangement");
    });
    await act(async () => {
      fireEvent.change(screen.getAllByRole("combobox", { name: /transport.structure.selector/ }).at(-1)!, {
        target: { value: "corto" },
      });
    });
    expect(useStructureStore.getState().draft?.arrangementId).toBe("corto");
    const draft = useStructureStore.getState().draft!;
    act(() => updateDraft((current) => duplicateBlock(current, draft.blocks[0].id)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "transport.structure.apply" }));
    });
    expect(base.structureHandlers.saveArrangement).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ id: "corto" }),
      true,
    );
  });
});
