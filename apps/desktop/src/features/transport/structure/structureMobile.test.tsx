import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import { act, en, fireEvent, render, screen, waitFor, within } from "../../../test/testUtils";
import { confirmDialog } from "../../../shared/dialog/dialogService";
import { useBackDismissStore } from "../mobile/backNavigation";
import { useSongStore } from "../songStore";
import { SongStructurePanel } from "./SongStructurePanel";
import { LONG_PRESS_MS, SWIPE_REMOVE_PX } from "./SwipeableRow";
import { UNDO_TOAST_MS } from "./SongStructureMobileScreen";
import { createStructureHandlers } from "./structureHandlers";
import { addBlock, openStructureEditor, updateDraft } from "./structureEditor";
import { useStructureStore } from "./structureStore";
import type { SongStructureSummary } from "./types";

vi.mock("../../../shared/dialog/dialogService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/dialog/dialogService")>()),
  confirmDialog: vi.fn(async () => false),
}));

const section = (markerId: string, name: string, start: number, end: number) => ({
  markerId,
  name,
  kind: "custom" as const,
  variant: null,
  color: null,
  implicit: false,
  startSeconds: start,
  endSeconds: end,
  bars: (end - start) / 2,
});

const STRUCTURE: SongStructureSummary = {
  sections: [
    section("intro", "Intro", 0, 8),
    section("verso", "Verso", 8, 24),
    section("coro", "Coro", 24, 40),
  ],
  arrangements: [
    {
      id: "domingo",
      name: "Domingo",
      blocks: [
        { id: "b1", sectionMarkerId: "intro" },
        { id: "b2", sectionMarkerId: "verso" },
        { id: "b3", sectionMarkerId: "coro" },
      ],
    },
  ],
  appliedArrangementId: "domingo",
};

function song(): SongView {
  const region: SongRegionSummary = {
    id: "r1",
    name: "Canción",
    startSeconds: 0,
    endSeconds: 40,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    structure: STRUCTURE,
  };
  return { regions: [region], clips: [], tracks: [], sectionMarkers: [] } as unknown as SongView;
}

/** jsdom has no PointerEvent: a MouseEvent with `pointerId` carries the
 * coordinates React and the window listeners read. */
function pointer(
  target: Element | Window,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: { pointerId: number; clientX: number; clientY: number },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  fireEvent(target, event);
}

const order = () => useStructureStore.getState().draft!.blocks.map((b) => b.sectionMarkerId);

/** Where a finger lands on a row: the block's name, deep inside it. */
function rowOf(blockId: string): HTMLElement {
  return document.querySelector(
    `[data-block-id="${blockId}"] .lt-structure-block-name`,
  ) as HTMLElement;
}

async function renderMobile() {
  useSongStore.setState({ song: song() });
  openStructureEditor("r1");
  const handlers = createStructureHandlers({
    runAction: async (work) => {
      await work();
    },
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
    t: (key) => key,
  });
  render(<SongStructurePanel handlers={handlers} variant="mobile" />);
  await screen.findByRole("dialog", {
    name: en.transport.structure.panelTitle.replace("{{song}}", "Canción"),
  });
}

/** Lay the rows out vertically (jsdom has no layout): 50 px each. */
function mockRowGeometry() {
  const items = Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"));
  items.forEach((item, index) => {
    item.getBoundingClientRect = () =>
      ({ top: index * 50, bottom: index * 50 + 50, left: 0, right: 300, width: 300, height: 50, x: 0, y: index * 50 }) as DOMRect;
  });
}

describe("arrangement editor on mobile — C1", () => {
  it("swiping a block left removes it and the toast undoes it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderMobile();
    const row = rowOf("b2");

    await act(async () => {
      pointer(row, "pointerdown", { pointerId: 1, clientX: 250, clientY: 70 });
      pointer(window, "pointermove", { pointerId: 1, clientX: 200, clientY: 72 });
      pointer(window, "pointermove", { pointerId: 1, clientX: 250 - SWIPE_REMOVE_PX - 20, clientY: 72 });
      pointer(window, "pointerup", { pointerId: 1, clientX: 250 - SWIPE_REMOVE_PX - 20, clientY: 72 });
    });

    expect(order()).toEqual(["intro", "coro"]);
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain(
      en.transport.structure.blockRemoved.replace("{{name}}", "Verso"),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.transport.structure.undoRemove }));
    });
    expect(order()).toEqual(["intro", "verso", "coro"]);
    expect(screen.queryByRole("status")).toBeNull();

    // And by itself the toast goes away after 4 s.
    await act(async () => {
      pointer(rowOf("b1"), "pointerdown", { pointerId: 2, clientX: 250, clientY: 20 });
      pointer(window, "pointermove", { pointerId: 2, clientX: 100, clientY: 20 });
      pointer(window, "pointerup", { pointerId: 2, clientX: 100, clientY: 20 });
    });
    expect(screen.getByRole("status")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(UNDO_TOAST_MS + 10);
    });
    expect(screen.queryByRole("status")).toBeNull();
    vi.useRealTimers();
  });

  it("a short swipe snaps back and removes nothing", async () => {
    await renderMobile();
    await act(async () => {
      pointer(rowOf("b2"), "pointerdown", { pointerId: 1, clientX: 250, clientY: 70 });
      pointer(window, "pointermove", { pointerId: 1, clientX: 220, clientY: 70 });
      pointer(window, "pointerup", { pointerId: 1, clientX: 220, clientY: 70 });
    });
    expect(order()).toEqual(["intro", "verso", "coro"]);
  });

  it("“+” opens the palette sheet; each tap adds at the end and the sheet stays open", async () => {
    await renderMobile();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.transport.structure.addSection }));
    });
    const sheet = screen.getByRole("dialog", { name: en.transport.structure.addSection });
    const chips = sheet.querySelectorAll("button.lt-structure-tap-row");
    await act(async () => {
      fireEvent.click(chips[2]); // Coro
      fireEvent.click(chips[2]); // Coro otra vez
    });
    expect(order()).toEqual(["intro", "verso", "coro", "coro", "coro"]);
    expect(screen.getByRole("dialog", { name: en.transport.structure.addSection })).toBeTruthy();
  });

  it("long-pressing a block opens its menu and Duplicate copies it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderMobile();
    await act(async () => {
      pointer(rowOf("b2"), "pointerdown", { pointerId: 1, clientX: 100, clientY: 70 });
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    await act(async () => {
      pointer(window, "pointerup", { pointerId: 1, clientX: 100, clientY: 70 });
    });
    const menu = screen.getByRole("menu", { name: "Verso" });
    await act(async () => {
      fireEvent.click(
        within(menu).getByRole("menuitem", { name: en.transport.structure.duplicateBlock }),
      );
    });
    expect(order()).toEqual(["intro", "verso", "verso", "coro"]);
    expect(screen.queryByRole("menu")).toBeNull();
    vi.useRealTimers();
  });
});

describe("arrangement editor on mobile — C2: handle vs scroll", () => {
  it("dragging by the handle reorders", async () => {
    await renderMobile();
    mockRowGeometry();
    const handle = document.querySelector(
      '[data-block-id="b1"] .lt-structure-handle',
    ) as HTMLElement;

    await act(async () => {
      pointer(handle, "pointerdown", { pointerId: 1, clientX: 280, clientY: 25 });
      pointer(window, "pointermove", { pointerId: 1, clientX: 280, clientY: 60 });
      pointer(window, "pointermove", { pointerId: 1, clientX: 280, clientY: 140 });
      pointer(window, "pointerup", { pointerId: 1, clientX: 280, clientY: 140 });
    });

    expect(order()).toEqual(["verso", "coro", "intro"]);
  });

  it("dragging anywhere else on the row scrolls and does not reorder", async () => {
    await renderMobile();
    mockRowGeometry();
    await act(async () => {
      pointer(rowOf("b1"), "pointerdown", { pointerId: 1, clientX: 120, clientY: 25 });
      pointer(window, "pointermove", { pointerId: 1, clientX: 121, clientY: 60 });
      pointer(window, "pointermove", { pointerId: 1, clientX: 122, clientY: 140 });
      // Ends with a plain pointerup (a real browser would usually cancel the
      // pointer once it starts panning): even then it must not reorder.
      pointer(window, "pointerup", { pointerId: 1, clientX: 122, clientY: 140 });
    });
    expect(order()).toEqual(["intro", "verso", "coro"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("arrangement editor on mobile — C3: Android back", () => {
  const pressBack = async () => {
    const top = useBackDismissStore.getState().stack.at(-1);
    await act(async () => {
      top?.close();
      await Promise.resolve();
    });
  };

  it("without changes, back closes the editor", async () => {
    await renderMobile();
    await pressBack();
    expect(useStructureStore.getState().editorRegionId).toBeNull();
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("with unapplied changes, back asks first (and stays when declined)", async () => {
    await renderMobile();
    await act(async () => {
      updateDraft((d) => addBlock(d, "coro"));
    });
    await pressBack();
    expect(confirmDialog).toHaveBeenCalledWith(en.transport.structure.closeWithChanges);
    expect(useStructureStore.getState().editorRegionId).toBe("r1");
  });

  it("back closes the palette sheet before the editor", async () => {
    await renderMobile();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.transport.structure.addSection }));
    });
    await pressBack();
    expect(screen.queryByRole("dialog", { name: en.transport.structure.addSection })).toBeNull();
    expect(useStructureStore.getState().editorRegionId).toBe("r1");
  });
});

describe("arrangement editor on mobile — iPhone feedback", () => {
  it("“Add section” sits after the last block, not floating over its handle", async () => {
    await renderMobile();
    const add = screen.getByRole("button", { name: en.transport.structure.addSection });
    expect(add.classList.contains("lt-structure-add-row")).toBe(true);
    expect(document.querySelector(".lt-structure-fab")).toBeNull();
    // In the same flow as the list, after it.
    const strip = screen.getByRole("list", { name: en.transport.structure.strip });
    expect(strip.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Apply saves, applies and closes the screen so the timeline shows the result", async () => {
    const desktopApi = await import("../desktopApi");
    const save = vi.spyOn(desktopApi, "saveSongArrangement").mockResolvedValue({
      snapshot: null as never,
      warnings: [],
      droppedBlocks: [],
    });
    await renderMobile();
    await act(async () => {
      updateDraft((d) => addBlock(d, "coro"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.transport.structure.apply }));
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][2]).toBe(true);
    expect(useStructureStore.getState().editorRegionId).toBeNull();
  });

  it("a failed Apply shows the error inside the screen and keeps it open", async () => {
    const desktopApi = await import("../desktopApi");
    vi.spyOn(desktopApi, "saveSongArrangement").mockRejectedValue(
      new Error("song structure locked: r1 arrangement=Domingo"),
    );
    await renderMobile();
    await act(async () => {
      updateDraft((d) => addBlock(d, "coro"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.transport.structure.apply }));
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      en.transport.structure.lockedStatus.replace("{{name}}", "Domingo"),
    );
    expect(useStructureStore.getState().editorRegionId).toBe("r1");
  });

  it("the ⋮ menu offers New, Rename and Delete as the app's mobile sheet", async () => {
    await renderMobile();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.transport.structure.moreActions }));
    });
    const menu = screen.getByRole("menu", { name: "Domingo" });
    expect(menu.classList.contains("is-mobile-sheet")).toBe(true);
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items.join("|")).toContain(en.transport.structure.newArrangement);
    expect(items.join("|")).toContain(en.transport.structure.rename);
    expect(items.join("|")).toContain(en.transport.structure.delete);
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /New|Nuevo/ }));
    });
    // A new arrangement starts from the original order, unsaved.
    expect(useStructureStore.getState().draft?.arrangementId).toBeNull();
  });
});

describe("arrangement editor on mobile — insert between sections", () => {
  it("the line before a block inserts there, and the next pick goes right after", async () => {
    await renderMobile();
    const gaps = screen.getAllByRole("button", { name: en.transport.structure.insertHere });
    expect(gaps).toHaveLength(3); // antes de cada bloque
    await act(async () => {
      fireEvent.click(gaps[1]); // entre Intro y Verso
    });
    const sheet = screen.getByRole("dialog", {
      name: en.transport.structure.insertAt.replace("{{n}}", "2"),
    });
    const rows = sheet.querySelectorAll("button.lt-structure-tap-row");
    await act(async () => {
      fireEvent.click(rows[2]); // Coro
    });
    await act(async () => {
      fireEvent.click(
        screen
          .getByRole("dialog", { name: en.transport.structure.insertAt.replace("{{n}}", "3") })
          .querySelectorAll("button.lt-structure-tap-row")[0], // Intro
      );
    });
    expect(order()).toEqual(["intro", "coro", "intro", "verso", "coro"]);
  });

  it("explains the touch gestures, not Delete and Ctrl+D", async () => {
    await renderMobile();
    expect(screen.getByText(en.transport.structure.stripHintTouch)).toBeTruthy();
    expect(screen.queryByText(en.transport.structure.stripHint)).toBeNull();
  });
});
