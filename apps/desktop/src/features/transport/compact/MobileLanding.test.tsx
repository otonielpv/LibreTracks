import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listDefaultSessions: vi.fn(),
  listSessionTemplates: vi.fn(),
  pickSessionFolder: vi.fn(),
}));

vi.mock("../desktopApi", () => ({
  isIOSApp: true,
  listDefaultSessions: api.listDefaultSessions,
  listSessionTemplates: api.listSessionTemplates,
  pickSessionFolder: api.pickSessionFolder,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

import { MobileLanding } from "./MobileLanding";

const baseProps = () => ({
  onCreateSession: vi.fn(),
  onCreateSessionFromTemplate: vi.fn(),
  onOpenSessionFromPath: vi.fn(),
});

describe("MobileLanding on iOS", () => {
  beforeEach(() => {
    api.listDefaultSessions.mockReset().mockResolvedValue([]);
    api.listSessionTemplates.mockReset().mockResolvedValue([]);
    api.pickSessionFolder.mockReset();
  });

  it("creates a named session in app storage without opening a folder picker", async () => {
    const props = baseProps();
    render(<MobileLanding {...props} />);

    await waitFor(() => {
      expect(api.listDefaultSessions).toHaveBeenCalled();
      expect(api.listSessionTemplates).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: "common.create" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Ensayo" },
    });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);

    expect(props.onCreateSession).toHaveBeenCalledWith("Ensayo");
    expect(api.pickSessionFolder).not.toHaveBeenCalled();
  });

  it("opens the only session saved in the iOS app container", async () => {
    api.listDefaultSessions.mockResolvedValue([
      {
        name: "Directo",
        songFile: "/private/songs/Directo/Directo.ltsession",
        modifiedMs: 123,
      },
    ]);
    const props = baseProps();
    render(<MobileLanding {...props} />);

    await waitFor(() => expect(api.listDefaultSessions).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "common.open" }));

    expect(props.onOpenSessionFromPath).toHaveBeenCalledWith(
      "/private/songs/Directo/Directo.ltsession",
    );
  });

  it("explains when there are no saved iOS sessions to open", async () => {
    const props = baseProps();
    render(<MobileLanding {...props} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "common.open" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.open" }));

    expect(screen.getByRole("alert").textContent).toBe(
      "Aún no hay sesiones guardadas en este dispositivo.",
    );
    expect(props.onOpenSessionFromPath).not.toHaveBeenCalled();
  });
});
