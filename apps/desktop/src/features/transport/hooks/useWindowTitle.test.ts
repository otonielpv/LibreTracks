import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { useSongStore } from "../songStore";
import { useWindowTitle } from "./useWindowTitle";

const setTitle = vi.fn(async () => {});

// The native window title comes from the Tauri window API, not from
// `document.title` — the regression this hook exists to prevent is setting only
// the document and leaving the title bar on the configured "LibreTracks".
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle }),
}));

const songWithSession = (sessionName: string | null): SongView =>
  ({ id: "song", sessionName, projectRevision: 1 }) as unknown as SongView;

describe("useWindowTitle", () => {
  beforeEach(() => {
    setTitle.mockClear();
    useSongStore.setState({ song: null });
  });

  it("shows the app name alone when no session is loaded", async () => {
    renderHook(() => useWindowTitle());
    await waitFor(() => expect(setTitle).toHaveBeenCalledWith("LibreTracks"));
    expect(document.title).toBe("LibreTracks");
  });

  it("puts the loaded project name in the native window title", async () => {
    useSongStore.setState({ song: songWithSession("Fallos en Cantos") });
    renderHook(() => useWindowTitle());
    await waitFor(() =>
      expect(setTitle).toHaveBeenCalledWith("LibreTracks — Fallos en Cantos"),
    );
    expect(document.title).toBe("LibreTracks — Fallos en Cantos");
  });

  it("follows a project rename", async () => {
    useSongStore.setState({ song: songWithSession("Antes") });
    renderHook(() => useWindowTitle());
    await waitFor(() => expect(setTitle).toHaveBeenCalledWith("LibreTracks — Antes"));

    useSongStore.setState({ song: songWithSession("Despues") });
    await waitFor(() =>
      expect(setTitle).toHaveBeenCalledWith("LibreTracks — Despues"),
    );
  });

  it("falls back to the app name when the session name is blank", async () => {
    useSongStore.setState({ song: songWithSession("   ") });
    renderHook(() => useWindowTitle());
    await waitFor(() => expect(setTitle).toHaveBeenCalledWith("LibreTracks"));
  });
});
