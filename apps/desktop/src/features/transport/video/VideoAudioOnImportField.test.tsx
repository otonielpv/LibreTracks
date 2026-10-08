import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VideoAudioOnImportField } from "./VideoAudioOnImportField";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(async () => undefined),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

const select = () => screen.getByRole("combobox", { name: "transport.video.settings.audioOnImport" }) as HTMLSelectElement;

describe("VideoAudioOnImportField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the choice remembered from the question", async () => {
    api.getSettings.mockResolvedValue({ locale: "es", videoAudioOnImport: "skip" });
    render(<VideoAudioOnImportField disabled={false} />);
    await waitFor(() => expect(select().value).toBe("skip"));
  });

  it("asks by default when nothing was remembered", async () => {
    api.getSettings.mockResolvedValue({ locale: "es" });
    render(<VideoAudioOnImportField disabled={false} />);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    expect(select().value).toBe("ask");
  });

  it("goes back to asking, keeping the other settings", async () => {
    api.getSettings.mockResolvedValue({ locale: "es", videoAudioOnImport: "skip", videoOutput: { enabled: true } });
    render(<VideoAudioOnImportField disabled={false} />);
    await waitFor(() => expect(select().value).toBe("skip"));
    fireEvent.change(select(), { target: { value: "ask" } });
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith({
        locale: "es",
        videoAudioOnImport: "ask",
        videoOutput: { enabled: true },
      }),
    );
  });

  it("is disabled where video cannot be placed", async () => {
    api.getSettings.mockResolvedValue({ locale: "es" });
    render(<VideoAudioOnImportField disabled />);
    expect(select().disabled).toBe(true);
  });
});
