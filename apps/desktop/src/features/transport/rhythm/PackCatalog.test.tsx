import { describe, expect, it, vi } from "vitest";

import { emitRhythmPackProgressForTest, setRhythmPacksForTest } from "../../../app/testDesktopApiMock";
import { act, fireEvent, render, screen, waitFor } from "../../../test/testUtils";
import { downloadRhythmPack } from "../desktopApi";
import { PackCatalog } from "./PackCatalog";

const pack = {
  id: "latin",
  name: "Latin",
  kind: "kit" as const,
  description: "",
  sizeBytes: 2 * 1024 * 1024,
  downloadUrl: "https://example/latin.zip",
  sha256: "abc",
  installed: false,
};

describe("PackCatalog", () => {
  it("lists the catalog, shows download progress and marks the pack installed", async () => {
    setRhythmPacksForTest({ packs: [pack], offline: false });
    const onInstalled = vi.fn();
    render(<PackCatalog onInstalled={onInstalled} />);
    const item = await screen.findByTestId("pack-latin");
    expect(item.textContent).toContain("Latin");
    expect(item.textContent).toContain("2.0 MB");
    act(() => emitRhythmPackProgressForTest({ packId: "latin", received: 1024 * 1024, total: 2 * 1024 * 1024, done: false }));
    const bar = screen.getByRole("progressbar", { name: "Downloading Latin" }) as HTMLProgressElement;
    expect(bar.value).toBe(50);
    act(() => emitRhythmPackProgressForTest({ packId: "latin", received: 1, total: 1, done: true }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(downloadRhythmPack).toHaveBeenCalledWith("latin"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy());
    expect(onInstalled).toHaveBeenCalled();
  });

  it("says when it is offline", async () => {
    setRhythmPacksForTest({ packs: [], offline: true });
    render(<PackCatalog />);
    expect(await screen.findByText("No connection: the catalog will show when you are online.")).toBeTruthy();
  });
});
