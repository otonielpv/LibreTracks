import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../../../../shared/i18n";
import type { LibraryDirEntry } from "../../desktopApi";
import { FolderLibraryPanel } from "./FolderLibraryPanel";

// iPhone/iPad: no drag (it fights the list scrolling); tap to select and add
// at the playhead, and a button per folder to make it a song.
const listLibraryDir = vi.fn<(path: string) => Promise<LibraryDirEntry[]>>();
vi.mock("../../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../desktopApi")>();
  return {
    ...actual,
    isMobileApp: true,
    listLibraryDir: (path: string) => listLibraryDir(path),
  };
});

const browserDrop = {
  dropPathsAt: vi.fn(),
  dropFolderAt: vi.fn(),
  addPathsAtPlayhead: vi.fn(),
  addFolderAtPlayhead: vi.fn(),
};

function renderPanel() {
  render(
    <FolderLibraryPanel
      settings={{
        mode: "folders",
        places: ["/Documents/Stems"],
        addPlace: vi.fn(async () => {}),
        removePlace: vi.fn(async () => {}),
        setMode: vi.fn(async () => {}),
      }}
      browserDrop={browserDrop}
      sessionPanel={null}
      sessionAssetCount={0}
    />,
  );
}

describe("FolderLibraryPanel on touch", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    listLibraryDir.mockResolvedValue([
      { name: "Drums.wav", path: "/Documents/Stems/Drums.wav", kind: "audio" },
      { name: "Bass.wav", path: "/Documents/Stems/Bass.wav", kind: "audio" },
    ]);
  });

  it("taps files into a selection and adds them at the playhead", async () => {
    renderPanel();
    fireEvent.click(screen.getByText("Stems"));
    fireEvent.click(await screen.findByText("Drums.wav"));
    fireEvent.click(screen.getByText("Bass.wav"));

    fireEvent.click(screen.getByRole("button", { name: /Add to timeline \(2\)/ }));
    expect(browserDrop.addPathsAtPlayhead).toHaveBeenCalledWith([
      "/Documents/Stems/Drums.wav",
      "/Documents/Stems/Bass.wav",
    ]);
    expect(browserDrop.dropPathsAt).not.toHaveBeenCalled();
  });

  it("adds a whole folder as a song at the playhead", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Add “Stems” as a song/ }));
    await waitFor(() =>
      expect(browserDrop.addFolderAtPlayhead).toHaveBeenCalledWith("Stems", [
        "/Documents/Stems/Drums.wav",
        "/Documents/Stems/Bass.wav",
      ]),
    );
  });
});
