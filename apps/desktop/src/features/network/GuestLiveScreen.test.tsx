import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongRegionSummary, SongView, TransportSnapshot } from "@libretracks/shared/models";

const flags = vi.hoisted(() => ({ lyrics: true, networkSessions: true }));
vi.mock("@libretracks/shared/featureFlags", () => ({ FEATURE_FLAGS: flags }));

// Every Tauri call made from this screen would go through `invoke`. The
// network API is mocked below, so anything reaching `invoke` would be a
// command on the guest's OWN session, which this screen must never send.
const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const network = vi.hoisted(() => ({
  leaveHost: vi.fn(async () => undefined),
  sendGuestCommand: vi.fn(async () => undefined),
}));
vi.mock("@libretracks/shared/networkApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libretracks/shared/networkApi")>();
  return { ...actual, ...network };
});

import i18n from "../../shared/i18n";
import { GuestLiveScreen } from "./GuestLiveScreen";
import {
  EMPTY_GUEST_STATUS,
  INITIAL_NETWORK_SESSION_STATE,
  useNetworkSessionStore,
} from "./networkSessionStore";
import { PERSONAL_CHORDS_KEY } from "./usePersonalChords";

const region = (
  id: string,
  name: string,
  startSeconds: number,
  endSeconds: number,
  chart: SongRegionSummary["chart"] = null,
): SongRegionSummary =>
  ({
    id,
    name,
    startSeconds,
    endSeconds,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    chart,
  }) as SongRegionSummary;

const song: SongView = {
  id: "session",
  title: "Directo",
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 80,
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [
    region("first", "Primera", 0, 40, {
      text: "{start_of_verse: Estrofa}\n[D]Hola [G]mundo\n{end_of_verse}",
      links: [{ markerId: "verse", section: 0 }],
    } as SongRegionSummary["chart"]),
    region("second", "Segunda", 40, 80),
  ],
  sectionMarkers: [
    { id: "verse", name: "Estrofa", startSeconds: 10, kind: "verse" },
    { id: "chorus", name: "Estribillo", startSeconds: 50, kind: "chorus" },
  ],
  clips: [],
  tracks: [],
  projectRevision: 1,
};

function playingAt(seconds: number) {
  return {
    snapshot: {
      playbackState: "playing",
      positionSeconds: seconds,
      transportClock: { anchorPositionSeconds: seconds, playbackRate: 1, running: true },
      pendingMarkerJump: null,
      activeVamp: null,
    } as unknown as TransportSnapshot,
    anchorPositionSeconds: seconds,
    emittedAtUnixMs: Date.now(),
  };
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(async () => {
  await i18n.changeLanguage("es");
  window.localStorage.removeItem(PERSONAL_CHORDS_KEY);
  window.localStorage.removeItem("lt.liveView.chartOpen");
  window.localStorage.removeItem("lt.liveChart.showChords");
  invoke.mockClear();
  network.leaveHost.mockClear();
  network.sendGuestCommand.mockClear();
  useNetworkSessionStore.setState({
    ...INITIAL_NETWORK_SESSION_STATE,
    guest: {
      ...EMPTY_GUEST_STATUS,
      joined: true,
      address: "192.168.1.20:3040",
      state: "connected",
      hostName: "PC del director",
      role: "viewer",
      rttMs: 20,
    },
    guestSong: song,
    guestTransport: playingAt(12),
  });
});

afterEach(() => cleanup());

function chordTexts() {
  return Array.from(document.querySelectorAll(".lt-chart-chord")).map((node) =>
    node.textContent?.trim(),
  );
}

describe("GuestLiveScreen as viewer", () => {
  it("shows the host's song, markers and lyrics", () => {
    render(<GuestLiveScreen />);
    expect(screen.getByText("PC del director")).toBeTruthy();
    expect(screen.getAllByText("Primera").length).toBeGreaterThan(0);
    expect(screen.getByText("Estrofa", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("Hola")).toBeTruthy();
    expect(chordTexts()).toEqual(["D", "G"]);
  });

  it("offers nothing that would change the host", () => {
    render(<GuestLiveScreen />);
    expect(screen.queryByLabelText(/Reproducir|Play/)).toBeNull();
    expect(document.querySelector(".lt-live-settings")).toBeNull();
    expect(document.querySelector(".lt-live-cancel")).toBeNull();
    const row = document.querySelector(".lt-live-cue-row");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    // Lyrics editing tools are gone too.
    expect(document.querySelector(".lt-live-chart-toolbar [aria-label*='dit']")).toBeNull();
  });

  it("capo and own key change only how this device reads the chords", () => {
    render(<GuestLiveScreen />);
    const chords = screen.getByRole("group", { name: "Acordes en este dispositivo" });
    fireEvent.click(within(chords).getByLabelText("Capo +"));
    fireEvent.click(within(chords).getByLabelText("Capo +"));
    expect(chordTexts()).toEqual(["C", "F"]);
    fireEvent.click(within(chords).getByLabelText("Tono +"));
    fireEvent.click(within(chords).getByLabelText("Tono +"));
    expect(chordTexts()).toEqual(["D", "G"]);
    // Remembered for this song on this device.
    expect(window.localStorage.getItem(PERSONAL_CHORDS_KEY)).toContain('"first"');
  });

  it("never sends a command to the guest's own session", () => {
    render(<GuestLiveScreen />);
    fireEvent.click(document.querySelector(".lt-live-cue-row") as HTMLElement);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves from the header", () => {
    render(<GuestLiveScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    expect(network.leaveHost).toHaveBeenCalled();
  });

  it("keeps the lyrics on screen when the connection drops", () => {
    useNetworkSessionStore.setState({
      guest: { ...useNetworkSessionStore.getState().guest, state: "lost" },
    });
    render(<GuestLiveScreen />);
    expect(document.querySelector(".lt-guest-banner")?.textContent).toMatch(/Conexión perdida/);
    expect(screen.getByText("Hola")).toBeTruthy();
  });

  it("waits for the host when there is no song yet", () => {
    useNetworkSessionStore.setState({ guestSong: null });
    render(<GuestLiveScreen />);
    expect(screen.getByText(/Esperando a que el anfitrión/)).toBeTruthy();
  });
});

describe("GuestLiveScreen as controller", () => {
  beforeEach(() => {
    useNetworkSessionStore.setState({
      guest: { ...useNetworkSessionStore.getState().guest, role: "controller" },
    });
  });

  it("a marker becomes a jump on the host, with the host's settings", async () => {
    useNetworkSessionStore.setState({
      guestLiveSettings: {
        globalJumpMode: "next_marker",
        globalJumpBars: 4,
        songJumpTrigger: "immediate",
        songJumpBars: 4,
        songTransitionMode: "instant",
        vampMode: "section",
        vampBars: 4,
      },
    });
    render(<GuestLiveScreen />);
    fireEvent.click(document.querySelector(".lt-live-cue-row") as HTMLElement);
    await waitFor(() =>
      expect(network.sendGuestCommand).toHaveBeenCalledWith(
        { cmd: "jumpToMarker", markerId: "verse", trigger: "next_marker", bars: 4 },
        undefined,
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("has the host's transport and the jump settings", async () => {
    render(<GuestLiveScreen />);
    expect(document.querySelector(".lt-live-settings")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pausa" }));
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    await waitFor(() => expect(network.sendGuestCommand).toHaveBeenCalledTimes(2));
    expect(network.sendGuestCommand.mock.calls.map((call) => call[0])).toEqual([
      { cmd: "pause" },
      { cmd: "stop" },
    ]);
  });

  it("loses the controls at once when the host lowers the role", () => {
    render(<GuestLiveScreen />);
    expect(screen.getByRole("button", { name: "Parar" })).toBeTruthy();
    act(() =>
      useNetworkSessionStore.setState({
        guest: { ...useNetworkSessionStore.getState().guest, role: "viewer" },
      }),
    );
    expect(screen.queryByRole("button", { name: "Parar" })).toBeNull();
    expect(document.querySelector(".lt-live-settings")).toBeNull();
  });

  it("shows the host's refusal", async () => {
    network.sendGuestCommand.mockRejectedValueOnce("forbidden" as never);
    render(<GuestLiveScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Tu rol no permite hacer esto.");
  });

  it("no controls while the connection is lost", () => {
    useNetworkSessionStore.setState({
      guest: { ...useNetworkSessionStore.getState().guest, state: "lost" },
    });
    render(<GuestLiveScreen />);
    expect(screen.queryByRole("button", { name: "Parar" })).toBeNull();
  });
});
