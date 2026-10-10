import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setGuestMirrorMode } from "@libretracks/shared/desktopApi";
import type { SongChart, SongRegionSummary, SongView } from "@libretracks/shared/models";
import type { NetworkGuestStatus } from "@libretracks/shared/networkApi";

import i18n from "../../shared/i18n";
import { LiveChartPanel } from "../transport/charts/LiveChartPanel";
import { formatTransportError } from "../transport/errors/formatTransportError";
import { networkNavState } from "./networkNavState";
import { mirrorTransition } from "./NetworkSessionRoot";
import { EMPTY_GUEST_STATUS } from "./networkSessionStore";
import { PERSONAL_CHORDS_KEY } from "./usePersonalChords";

function guest(overrides: Partial<NetworkGuestStatus>): NetworkGuestStatus {
  return { ...EMPTY_GUEST_STATUS, joined: true, ...overrides };
}

describe("mirror mode transitions", () => {
  it("enters once joined and connected", () => {
    expect(mirrorTransition(false, "connecting", guest({ state: "connected" }))).toBe("enter");
    expect(mirrorTransition(false, "", guest({ state: "connecting" }))).toBeNull();
    expect(mirrorTransition(false, "", EMPTY_GUEST_STATUS)).toBeNull();
  });

  it("leaves when the session is over", () => {
    expect(mirrorTransition(true, "connected", { joined: false, state: "closed" })).toBe("leave");
    expect(mirrorTransition(true, "connected", guest({ state: "rejected" }))).toBe("leave");
  });

  it("refreshes after a lost connection comes back, not on every update", () => {
    expect(mirrorTransition(true, "lost", guest({ state: "connected" }))).toBe("refresh");
    expect(mirrorTransition(true, "connected", guest({ state: "connected" }))).toBeNull();
    // Lost but still joined: keep the screen, it reconnects on its own.
    expect(mirrorTransition(true, "connected", guest({ state: "lost" }))).toBeNull();
  });
});

describe("side-nav state", () => {
  it("reflects hosting and following", () => {
    expect(networkNavState(null, EMPTY_GUEST_STATUS)).toBeNull();
    expect(
      networkNavState(
        { hosting: true, hostName: "", port: 1, addresses: [], joinUrl: null, guests: [], trusted: [] },
        EMPTY_GUEST_STATUS,
      ),
    ).toBe("ok");
    expect(networkNavState(null, guest({ state: "connected" }))).toBe("ok");
    expect(networkNavState(null, guest({ state: "connecting" }))).toBe("pending");
    expect(networkNavState(null, guest({ state: "lost" }))).toBe("error");
  });
});

describe("guest errors", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("es");
  });

  it("are explained in the user's language", () => {
    const t = i18n.t.bind(i18n);
    expect(formatTransportError(new Error("guest:forbidden"), t)).toMatch(/Tu rol/);
    expect(formatTransportError(new Error("guest:notAvailable"), t)).toMatch(/dispositivo que hospeda/);
    expect(formatTransportError(new Error("guest:somethingNew"), t)).toBe("El anfitrión no pudo hacerlo.");
  });
});

describe("personal chords in the lyrics panel", () => {
  const chart: SongChart = {
    text: "{section: Verso}\n[D]Hola [G]mundo",
    links: [{ markerId: "verse", section: 0 }],
  } as SongChart;
  const region = {
    id: "song",
    name: "Eres",
    startSeconds: 0,
    endSeconds: 40,
    transposeSemitones: 0,
    key: "D",
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    chart,
  } as SongRegionSummary;
  const song = {
    id: "s",
    title: "S",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 40,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions: [region],
    sectionMarkers: [{ id: "verse", name: "Verso", startSeconds: 0, kind: "verse" }],
    clips: [],
    tracks: [],
    projectRevision: 1,
  } as SongView;

  const renderPanel = () =>
    render(
      <LiveChartPanel
        song={song}
        region={region}
        positionSecondsRef={{ current: 1 }}
        pendingMarkerId={null}
        expanded={false}
        onToggleExpanded={vi.fn()}
        onClose={vi.fn()}
        onChartChange={vi.fn(async () => {})}
      />,
    );
  const chords = () =>
    [...document.querySelectorAll(".lt-chart-chord")].map((node) => node.textContent?.trim()).filter(Boolean);

  beforeEach(async () => {
    await i18n.changeLanguage("es");
    window.localStorage.clear();
    HTMLElement.prototype.scrollTo = vi.fn() as never;
  });

  afterEach(() => {
    setGuestMirrorMode(false);
    cleanup();
  });

  it("is not offered on the host's own device", () => {
    renderPanel();
    expect(screen.queryByLabelText("Acordes en este dispositivo")).toBeNull();
  });

  it("lets a guest read the host's song with a capo, on this device only", () => {
    setGuestMirrorMode(true);
    renderPanel();
    expect(chords()).toEqual(["D", "G"]);
    fireEvent.click(screen.getByRole("button", { name: "Acordes en este dispositivo" }));
    fireEvent.click(screen.getByLabelText("Capo +"));
    fireEvent.click(screen.getByLabelText("Capo +"));
    expect(chords()).toEqual(["C", "F"]);
    expect(window.localStorage.getItem(PERSONAL_CHORDS_KEY)).toContain('"song"');
  });
});
