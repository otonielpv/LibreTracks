import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../../../../shared/i18n";
import type { LibraryDirEntry } from "../../desktopApi";
import { FolderLibraryPanel } from "./FolderLibraryPanel";
import type { LibrarySettings } from "./useLibrarySettings";

const listLibraryDir = vi.fn<(path: string) => Promise<LibraryDirEntry[]>>();
vi.mock("../../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../desktopApi")>();
  return { ...actual, listLibraryDir: (path: string) => listLibraryDir(path) };
});

function settings(places: string[]): LibrarySettings {
  return {
    mode: "folders",
    places,
    addPlace: vi.fn(async () => {}),
    removePlace: vi.fn(async () => {}),
    setMode: vi.fn(async () => {}),
  };
}

const browserDrop = {
  dropPathsAt: vi.fn(),
  dropFolderAt: vi.fn(),
  addPathsAtPlayhead: vi.fn(),
  addFolderAtPlayhead: vi.fn(),
  previewAt: vi.fn(),
  clearPreview: vi.fn(),
};

function renderPanel(places: string[]) {
  const value = settings(places);
  render(
    <FolderLibraryPanel
      settings={value}
      browserDrop={browserDrop}
      sessionPanel={<div>classic library</div>}
      sessionAssetCount={3}
    />,
  );
  return value;
}

describe("FolderLibraryPanel", () => {
  beforeEach(async () => {
    listLibraryDir.mockReset();
    window.localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it("explains what to do when no folder is added yet", () => {
    renderPanel([]);
    expect(screen.getByText(/Add a folder of your disk/)).toBeTruthy();
  });

  it("reads a folder only when it is opened, one level at a time", async () => {
    listLibraryDir.mockResolvedValue([
      { name: "Oceans", path: "D:/Stems/Oceans", kind: "folder" },
      { name: "Click.wav", path: "D:/Stems/Click.wav", kind: "audio" },
    ]);
    renderPanel(["D:/Stems"]);
    expect(listLibraryDir).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Stems"));
    expect(await screen.findByText("Click.wav")).toBeTruthy();
    expect(screen.getByText("Oceans")).toBeTruthy();
    expect(listLibraryDir).toHaveBeenCalledTimes(1);
    expect(listLibraryDir).toHaveBeenCalledWith("D:/Stems");
  });

  it("filters files by the search, keeping folders reachable", async () => {
    listLibraryDir.mockResolvedValue([
      { name: "Oceans", path: "D:/Stems/Oceans", kind: "folder" },
      { name: "Batería.wav", path: "D:/Stems/Batería.wav", kind: "audio" },
      { name: "Bajo.wav", path: "D:/Stems/Bajo.wav", kind: "audio" },
    ]);
    renderPanel(["D:/Stems"]);
    fireEvent.click(screen.getByText("Stems"));
    await screen.findByText("Bajo.wav");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bateria" } });
    await waitFor(() => expect(screen.queryByText("Bajo.wav")).toBeNull());
    expect(screen.getByText("Batería.wav")).toBeTruthy();
    expect(screen.getByText("Oceans")).toBeTruthy();
  });

  it("says when a folder is gone instead of breaking", async () => {
    listLibraryDir.mockRejectedValue("not found");
    renderPanel(["D:/Gone"]);
    fireEvent.click(screen.getByText("Gone"));
    expect(await screen.findByText(/Folder not available/)).toBeTruthy();
  });

  // jsdom has no PointerEvent: MouseEvent with the pointer event names carries
  // clientX/clientY, which is all the drag reads.
  it("drags a file from the disk onto the timeline", async () => {
    listLibraryDir.mockResolvedValue([
      { name: "Click.wav", path: "D:/Stems/Click.wav", kind: "audio" },
    ]);
    renderPanel(["D:/Stems"]);
    fireEvent.click(screen.getByText("Stems"));
    const row = await screen.findByText("Click.wav");

    act(() => {
      row.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      );
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 200 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 300, clientY: 200 }));
    });

    await waitFor(() =>
      expect(browserDrop.dropPathsAt).toHaveBeenCalledWith(["D:/Stems/Click.wav"], 300, 200),
    );
    // While dragging, the timeline showed where it would land; the drop
    // cleared it.
    expect(browserDrop.previewAt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "files", paths: ["D:/Stems/Click.wav"] }),
      300,
      200,
    );
    expect(browserDrop.clearPreview).toHaveBeenCalled();
  });

  it("removes a place", () => {
    const value = renderPanel(["D:/Stems"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove from library" }));
    expect(value.removePlace).toHaveBeenCalledWith("D:/Stems");
  });

  it("keeps the session audio folded under In this session", () => {
    renderPanel([]);
    expect(screen.getByText("classic library")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /In this session \(3\)/ }));
    expect(screen.queryByText("classic library")).toBeNull();
  });
});
