import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCloudStore } from "../cloud/cloudStore";
import { ExportSessionModal } from "../panels/ExportSessionModal";
import { ExportSongModal } from "../panels/ExportSongModal";
import { CLOUD_VIDEO_DEFAULT_OFF_BYTES, defaultIncludeVideo, formatBytes } from "./VideoExportOption";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "size" in options ? `${key}:${options.count}:${options.size}` : key,
    i18n: { language: "es" },
  }),
}));

const api = vi.hoisted(() => ({
  getVideoExportPayload: vi.fn(),
}));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

const GB = 1024 * 1024 * 1024;

describe("VideoExportOption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCloudStore.setState({ exportTarget: null });
  });
  afterEach(() => useCloudStore.setState({ exportTarget: null }));

  it("shows the count and size, ticked by default, and passes includeVideo on", async () => {
    api.getVideoExportPayload.mockResolvedValue({ count: 3, bytes: 2.4 * GB });
    const onConfirm = vi.fn();
    render(<ExportSessionModal isOpen sessionTitle="Set" onCancel={() => {}} onConfirm={onConfirm} />);
    expect(await screen.findByText("transport.video.export.summary:3:2,4 GB")).toBeTruthy();
    expect(api.getVideoExportPayload).toHaveBeenCalledWith(null);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);

    fireEvent.click(screen.getByText("transport.exportSessionModal.confirm"));
    expect(onConfirm).toHaveBeenLastCalledWith("full", true);

    fireEvent.click(box);
    fireEvent.click(screen.getByText("transport.exportSessionModal.confirm"));
    expect(onConfirm).toHaveBeenLastCalledWith("full", false);
  });

  it("in Light mode only notes that videos are referenced", async () => {
    api.getVideoExportPayload.mockResolvedValue({ count: 1, bytes: 10 });
    const onConfirm = vi.fn();
    render(<ExportSessionModal isOpen sessionTitle="Set" onCancel={() => {}} onConfirm={onConfirm} />);
    await screen.findByText("transport.video.export.summary:1:10 B");
    fireEvent.click(screen.getAllByRole("radio")[2]);
    expect(screen.getByText("transport.video.export.lightNote")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByText("transport.exportSessionModal.confirm"));
    expect(onConfirm).toHaveBeenLastCalledWith("light", false);
  });

  it("without video there is no block and nothing changes", async () => {
    api.getVideoExportPayload.mockResolvedValue({ count: 0, bytes: 0 });
    const onConfirm = vi.fn();
    render(<ExportSessionModal isOpen sessionTitle="Set" onCancel={() => {}} onConfirm={onConfirm} />);
    await waitFor(() => expect(api.getVideoExportPayload).toHaveBeenCalled());
    expect(screen.queryByText(/transport.video.export/)).toBeNull();
    fireEvent.click(screen.getByText("transport.exportSessionModal.confirm"));
    expect(onConfirm).toHaveBeenLastCalledWith("full", false);
  });

  it("an upload to the cloud of more than 500 MB starts without the videos", async () => {
    useCloudStore.setState({ exportTarget: "cloud" });
    api.getVideoExportPayload.mockResolvedValue({ count: 2, bytes: 0.8 * GB });
    render(<ExportSessionModal isOpen sessionTitle="Set" onCancel={() => {}} onConfirm={() => {}} />);
    await screen.findByText(/transport.video.export.summary/);
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false));
  });

  it("the song dialog asks for that song's videos and passes the choice", async () => {
    api.getVideoExportPayload.mockResolvedValue({ count: 1, bytes: 180 * 1024 * 1024 });
    const onConfirm = vi.fn();
    render(
      <ExportSongModal target={{ regionId: "r2", regionName: "Coro" }} onCancel={() => {}} onConfirm={onConfirm} />,
    );
    expect(await screen.findByText("transport.video.export.summary:1:180 MB")).toBeTruthy();
    expect(api.getVideoExportPayload).toHaveBeenCalledWith("r2");
    fireEvent.click(screen.getByText("transport.exportModal.confirm"));
    expect(onConfirm).toHaveBeenLastCalledWith("r2", true, true);
  });

  it("defaults and sizes", () => {
    expect(defaultIncludeVideo(CLOUD_VIDEO_DEFAULT_OFF_BYTES + 1, true)).toBe(false);
    expect(defaultIncludeVideo(CLOUD_VIDEO_DEFAULT_OFF_BYTES + 1, false)).toBe(true);
    expect(defaultIncludeVideo(CLOUD_VIDEO_DEFAULT_OFF_BYTES, true)).toBe(true);
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
  });
});
