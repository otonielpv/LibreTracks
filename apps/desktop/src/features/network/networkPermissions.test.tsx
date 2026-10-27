import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGuestMirrorMode, setGuestRole } from "@libretracks/shared/desktopApi";
import type { NetworkRole } from "@libretracks/shared/networkRoles";
import type { NetworkGuestStatus } from "@libretracks/shared/networkApi";
import { SetlistView } from "../transport/setlist/SetlistView";
import { testSetlistProps } from "../transport/setlist/testBindings";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "../transport/setlist/setlistStore";
import { EMPTY_GUEST_STATUS, useNetworkSessionStore } from "./networkSessionStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function role(role: NetworkRole, state: NetworkGuestStatus["state"] = "connected") {
  useNetworkSessionStore.getState().setGuest({
    ...EMPTY_GUEST_STATUS, joined: true, state, role,
  });
}

beforeEach(() => {
  setGuestMirrorMode(true);
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
});
afterEach(() => {
  cleanup();
  setGuestMirrorMode(false);
  setGuestRole(null);
  useNetworkSessionStore.getState().setGuest(EMPTY_GUEST_STATUS);
});

describe("Setlist network permissions", () => {
  it("lets a viewer select songs but not cue, play, edit, mix or import", () => {
    role("viewer");
    const props = testSetlistProps();
    props.onCueSong = vi.fn();
    props.onPlaySong = vi.fn();
    props.onSelectRegion = vi.fn();
    props.onMasterGainChange = vi.fn();
    render(<SetlistView {...props} layoutClass="wide" />);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.songs.tileLabel" }));
    expect(props.onSelectRegion).toHaveBeenCalled();
    expect(props.onCueSong).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "setlistView.songs.play" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "setlistView.edit.button" }).matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "setlistView.songs.newSong" })).toBeNull();
    const master = screen.getByRole("slider", { name: "setlistView.mixer.masterAria" });
    fireEvent.keyDown(master, { key: "ArrowUp" });
    expect(props.onMasterGainChange).not.toHaveBeenCalled();
  });

  it("lets a controller play without enabling editing or mix", () => {
    role("controller");
    const props = testSetlistProps();
    props.onPlaySong = vi.fn();
    props.onMasterGainChange = vi.fn();
    render(<SetlistView {...props} layoutClass="wide" />);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.songs.play" }));
    expect(props.onPlaySong).toHaveBeenCalledWith("song-1", "song-1");
    expect(screen.getByRole("button", { name: "setlistView.edit.button" }).matches(":disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("slider", { name: "setlistView.mixer.masterAria" }), { key: "ArrowUp" });
    expect(props.onMasterGainChange).not.toHaveBeenCalled();
  });

  it("enables editor controls and closes them immediately after a role downgrade", () => {
    role("editor");
    const props = testSetlistProps();
    render(<SetlistView {...props} layoutClass="wide" />);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.edit.button" }));
    expect(useSetlistStore.getState().editMode).toBe("song");
    act(() => role("viewer"));
    expect(useSetlistStore.getState().editMode).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "setlistView.songs.play" }).matches(":disabled")).toBe(true);
  });

  it("disables mutations while an editor reconnects", () => {
    role("editor", "lost");
    render(<SetlistView {...testSetlistProps()} layoutClass="wide" />);
    expect(screen.getByRole("button", { name: "setlistView.edit.button" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "setlistView.songs.play" }).matches(":disabled")).toBe(true);
  });
});
