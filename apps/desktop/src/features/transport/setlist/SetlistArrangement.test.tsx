import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongRegionSummary, SongView } from "@libretracks/shared/models";

import { useSongStore } from "../songStore";
import { SongStructurePanel } from "../structure/SongStructurePanel";
import type { StructureHandlers } from "../structure/structureHandlers";
import { INITIAL_STRUCTURE_STATE, useStructureStore } from "../structure/structureStore";
import { updateDraft, duplicateBlock } from "../structure/structureEditor";
import { useTimelineUIStore } from "../uiStore";
import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, requestEditMode, useSetlistStore } from "./setlistStore";
import { testRegion, testSetlistProps } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.message ? `${key}:${String(options.message)}` : options?.name ? `${key}:${String(options.name)}` : key,
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
    if (layoutClass === "short") {
      expect(container.querySelector("[data-setlist-zone='overview'] .lt-structure-editor")).toBeNull();
      expect(container.querySelector(".lt-setlist-arrangement-mobile-waveform .lt-setlist-overview.is-seekable")).not.toBeNull();
      expect(container.querySelector(".lt-setlist-bar-ruler.is-arrangement")).not.toBeNull();
    } else {
      expect(container.querySelector("[data-setlist-zone='overview'] .lt-structure-editor")).not.toBeNull();
      expect(container.querySelector("[data-setlist-zone='drawer'] .lt-structure-editor")).toBeNull();
    }
    expect(container.querySelector("[data-setlist-zone='mixer']")).toBeNull();
    expect(container.querySelectorAll(".lt-setlist-arrangement-wave-block canvas")).toHaveLength(2);
    // Embedded: the app's own panel stays hidden.
    expect(useStructureStore.getState().editorHost).toBe("embedded");
  });

  it("the DAW's arrangement panel does not show while embedded", () => {
    useSongStore.setState({ song: { regions: [region] } as unknown as SongView });
    useStructureStore.setState({ editorRegionId: "r1", editorHost: "embedded" });
    const { container } = render(<SongStructurePanel handlers={handlers()} variant="desktop" />);
    expect(container.querySelector(".lt-structure-panel")).toBeNull();
  });

  it("keeps the wave editor in its two-row layout with a saved song-row height", async () => {
    useSetlistStore.setState({ ...INITIAL_SETLIST_STATE, songsHeightPx: 180 });
    const { container } = render(<SetlistView {...props()} layoutClass="wide" />);
    await act(async () => {
      await requestEditMode("arrangement");
    });

    const view = container.querySelector<HTMLElement>(".lt-setlist-view")!;
    expect(view.classList.contains("has-songs-height")).toBe(true);
    expect(view.classList.contains("is-wave-editing")).toBe(true);
    expect(container.querySelector("[data-setlist-zone='mixer']")).toBeNull();
  });

  it("gives the short sections editor a separate scrolling list and action bar", async () => {
    const { container } = render(<SetlistView {...props()} layoutClass="short" />);
    await act(async () => {
      await requestEditMode("sections");
    });
    const body = container.querySelector(".lt-setlist-drawer-body.is-sections-mode");
    expect(body?.querySelector(".lt-setlist-sections.is-short > .lt-setlist-sections-list")).not.toBeNull();
    expect(body?.querySelector(".lt-setlist-sections.is-short > .lt-setlist-sections-bar")).not.toBeNull();
  });

  it("short arrangement editing exposes its seekable waveform, bar ruler and snap toggle", async () => {
    useTimelineUIStore.setState({ snapEnabled: false });
    const { container } = render(<SetlistView {...props()} layoutClass="short" />);
    await act(async () => {
      await requestEditMode("arrangement");
    });

    expect(container.querySelector(".lt-setlist-arrangement-mobile-waveform .lt-setlist-overview.is-seekable")).not.toBeNull();
    expect(container.querySelector(".lt-setlist-bar-ruler.is-arrangement")).not.toBeNull();
    const snap = container.querySelector<HTMLButtonElement>(
      ".lt-setlist-arrangement-actions [aria-label='timelineToolbar.enableSnap']",
    )!;
    expect(snap.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(snap);
    expect(useTimelineUIStore.getState().snapEnabled).toBe(true);
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
      fireEvent.change(screen.getByRole("combobox", { name: "transport.structure.selector" }), { target: { value: "corto" } });
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
    expect(useSetlistStore.getState().editMode).toBeNull();
  });

  it.each(["wide", "short"] as const)("%s: Apply keeps a failed draft open and shows its error", async (layoutClass) => {
    const own = handlers();
    vi.mocked(own.saveArrangement).mockResolvedValue({ ok: false, error: new Error("Cannot apply arrangement") });
    render(<SetlistView {...props(own)} layoutClass={layoutClass} />);
    await act(async () => { await requestEditMode("arrangement"); });
    const draft = useStructureStore.getState().draft!;
    act(() => updateDraft((current) => duplicateBlock(current, draft.blocks[0].id)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "transport.structure.apply" }));
    });
    expect(own.saveArrangement).toHaveBeenCalledWith("r1", expect.objectContaining({
      blocks: expect.arrayContaining([expect.objectContaining({ sectionMarkerId: "Verso" })]),
    }), true);
    expect(screen.getByRole("alert").textContent).toContain("Cannot apply arrangement");
    expect(screen.getByRole("alert").closest(".lt-setlist-arrangement-footer")).not.toBeNull();
    expect(useSetlistStore.getState().editMode).toBe("arrangement");
    expect(useStructureStore.getState().draft?.blocks).toHaveLength(3);
    vi.mocked(own.saveArrangement).mockResolvedValue({ ok: true, error: null });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "transport.structure.apply" }));
    });
    expect(useSetlistStore.getState().editMode).toBeNull();
  });

  it("the drawer selects an arrangement from a dropdown and previews only that arrangement", async () => {
    const { container } = render(<SetlistView {...props()} layoutClass="wide" />);
    await act(async () => {
      await requestEditMode("arrangement");
    });
    const select = screen.getByRole("combobox", { name: "transport.structure.selector" });
    expect(Array.from(select.querySelectorAll("option")).map((option) => option.textContent)).toEqual([
      "transport.structure.original (transport.structure.appliedBadge)", "Corto",
    ]);
    expect(container.querySelectorAll(".lt-setlist-arrangement-sequence")).toHaveLength(1);
    expect(container.querySelectorAll(".lt-setlist-arrangement-segment")).toHaveLength(2);
    await act(async () => fireEvent.change(select, { target: { value: "corto" } }));
    expect(container.querySelectorAll(".lt-setlist-arrangement-segment")).toHaveLength(1);
  });

  it("the selected preview shows the working copy, unapplied changes included", async () => {
    const { container } = render(<SetlistView {...props()} layoutClass="wide" />);
    await act(async () => {
      await requestEditMode("arrangement");
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "transport.structure.selector" }), { target: { value: "corto" } });
    });
    const draft = useStructureStore.getState().draft!;
    act(() => updateDraft((current) => duplicateBlock(current, draft.blocks[0].id)));
    expect(screen.getByRole("combobox", { name: "transport.structure.selector" })).toHaveProperty("value", "corto");
    expect(container.querySelectorAll(".lt-setlist-arrangement-segment")).toHaveLength(2);
  });

  it("edits the selected waveform section with the inspector actions", async () => {
    const { container } = render(<SetlistView {...props()} layoutClass="short" />);
    await act(async () => { await requestEditMode("arrangement"); });
    fireEvent.click(container.querySelector(".lt-setlist-arrangement-wave-block .lt-structure-block")!);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.duplicate" }));
    expect(useStructureStore.getState().draft?.blocks.map((block) => block.sectionMarkerId)).toEqual(["Verso", "Verso", "Coro"]);
    expect(useStructureStore.getState().draft?.isOriginal).toBe(false);
    expect(screen.queryByRole("button", { name: "setlistView.arrangement.moveRight" })).toBeNull();
    expect(screen.queryByRole("button", { name: "setlistView.arrangement.moveLeft" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.delete" }));
    expect(useStructureStore.getState().draft?.blocks).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "transport.structure.addSection" }), { target: { value: "Coro" } });
    expect(useStructureStore.getState().draft?.blocks.map((block) => block.sectionMarkerId)).toEqual(["Verso", "Coro", "Coro"]);
  });

  it.each(["wide", "short"] as const)("%s inserts sections at each waveform boundary without applying", async (layoutClass) => {
    const base = props();
    const openMenu = vi.fn();
    const { container } = render(<SetlistView {...base} menus={{ ...base.menus, openMenu }} layoutClass={layoutClass} />);
    await act(async () => { await requestEditMode("arrangement"); });
    const insert = (index: number, sectionIndex: number) => {
      fireEvent.click(container.querySelector(`[data-insert-index='${index}']`)!);
      const actions = openMenu.mock.lastCall![2] as Parameters<typeof base.menus.openMenu>[2];
      expect(actions.map((action) => action.label)).toEqual(["Verso", "Coro"]);
      act(() => { void actions[sectionIndex].onSelect?.(); });
    };
    expect(container.querySelectorAll(".lt-setlist-arrangement-insert")).toHaveLength(3);
    insert(1, 1);
    expect(useStructureStore.getState().draft?.blocks.map((block) => block.sectionMarkerId)).toEqual(["Verso", "Coro", "Coro"]);
    insert(0, 1);
    expect(useStructureStore.getState().draft?.blocks[0].sectionMarkerId).toBe("Coro");
    insert(4, 0);
    expect(useStructureStore.getState().draft?.blocks.at(-1)?.sectionMarkerId).toBe("Verso");
    expect(base.structureHandlers.saveArrangement).not.toHaveBeenCalled();
    expect(base.structureHandlers.applyArrangement).not.toHaveBeenCalled();
  });

  it.each(["wide", "short"] as const)("%s reorders by the handle, not by swiping the waveform", async (layoutClass) => {
    const { container } = render(<SetlistView {...props()} layoutClass={layoutClass} />);
    await act(async () => { await requestEditMode("arrangement"); });
    const items = Array.from(container.querySelectorAll<HTMLElement>(".lt-setlist-arrangement .lt-structure-item[data-block-id]"));
    items.forEach((item, index) => {
      item.getBoundingClientRect = () => ({ x: index * 150, y: 0, left: index * 150, right: (index + 1) * 150, top: 0, bottom: 200, width: 150, height: 200 }) as DOMRect;
    });
    const pointer = (target: Element | Window, type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 100 });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
      fireEvent(target, event);
    };
    const before = useStructureStore.getState().draft;
    pointer(items[0].querySelector(".lt-structure-block")!, "pointerdown", 50);
    pointer(window, "pointermove", 290);
    pointer(window, "pointerup", 290);
    expect(useStructureStore.getState().draft).toBe(before);

    const handle = items[0].querySelector("button.lt-structure-handle")!;
    pointer(handle, "pointerdown", 50);
    pointer(window, "pointermove", 290);
    expect(useStructureStore.getState().draft).toBe(before);
    pointer(window, "pointercancel", 290);
    expect(useStructureStore.getState().draft).toBe(before);
    expect(document.querySelector(".lt-drag-lift")).toBeNull();

    pointer(handle, "pointerdown", 50);
    pointer(window, "pointermove", 290);
    pointer(window, "pointerup", 290);
    const after = useStructureStore.getState().draft!;
    expect(after.blocks.map((block) => block.sectionMarkerId)).toEqual(["Coro", "Verso"]);
    expect(useStructureStore.getState().selectedBlockId).toBe(after.blocks[1].id);
  });

  it("the reorder handle is keyboard-accessible", async () => {
    const { container } = render(<SetlistView {...props()} layoutClass="short" />);
    await act(async () => { await requestEditMode("arrangement"); });
    fireEvent.keyDown(container.querySelector("button.lt-structure-handle")!, { key: "ArrowRight" });
    expect(useStructureStore.getState().draft?.blocks.map((block) => block.sectionMarkerId)).toEqual(["Coro", "Verso"]);
    const handles = container.querySelectorAll("button.lt-structure-handle");
    fireEvent.keyDown(handles[1], { key: "Home" });
    expect(useStructureStore.getState().draft?.blocks.map((block) => block.sectionMarkerId)).toEqual(["Verso", "Coro"]);
  });
});
