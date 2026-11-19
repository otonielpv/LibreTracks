import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView, TrackSummary } from "@libretracks/shared/models";

import "../../../shared/i18n";
import { useSongStore } from "../songStore";
import { useTransportStore } from "../store";
import { ClearSoloButton } from "./ClearSoloButton";

const track = (id: string, solo: boolean) =>
  ({ id, name: id, solo, muted: false }) as unknown as TrackSummary;

const loadTracks = (tracks: TrackSummary[]) =>
  useSongStore.setState({ song: { tracks } as unknown as SongView });

describe("ClearSoloButton", () => {
  beforeEach(() => {
    useSongStore.setState({ song: null });
    useTransportStore.setState({ optimisticMix: {} });
  });
  afterEach(cleanup);

  it("is off while no track is soloed", () => {
    loadTracks([track("a", false), track("b", false)]);
    render(<ClearSoloButton onClear={vi.fn()} />);

    const button = screen.getByRole("button", { name: /clear all solos/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).not.toContain("is-solo-active");
  });

  it("lights up with a soloed track and clears on click", () => {
    const onClear = vi.fn();
    loadTracks([track("a", false), track("b", true)]);
    render(<ClearSoloButton onClear={onClear} />);

    const button = screen.getByRole("button", { name: /clear all solos/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.className).toContain("is-solo-active");
    fireEvent.click(button);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("follows the optimistic solo before the engine confirms it", () => {
    loadTracks([track("a", false)]);
    render(<ClearSoloButton onClear={vi.fn()} />);
    const button = screen.getByRole("button", { name: /clear all solos/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    act(() => useTransportStore.getState().setOptimisticMix("a", { solo: true }));
    expect((button as HTMLButtonElement).disabled).toBe(false);

    act(() => useTransportStore.getState().setOptimisticMix("a", { solo: false }));
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
