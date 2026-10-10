import { create } from "zustand";

import type {
  NetworkGuestSnapshot,
  NetworkGuestStatus,
  NetworkGuestTransport,
  NetworkHostStatus,
  NetworkLiveSettings,
} from "@libretracks/shared/networkApi";
import type { SongView } from "@libretracks/shared/models";

/**
 * Network sessions, host and guest side (docs/plans/network-sessions).
 *
 * A store and not component state: the side-nav button, the topbar badge,
 * the modal and the guest screen never share a parent, and a session keeps
 * running with the modal closed. Nothing of this lives in
 * `TransportPanelContent` (repo rule: a new feature brings its own module).
 */

export const EMPTY_GUEST_STATUS: NetworkGuestStatus = {
  joined: false,
  address: "",
  state: "",
  reason: null,
  expectedProtocol: null,
  hostName: "",
  role: null,
  rttMs: null,
  peers: [],
};

export type NetworkSessionState = {
  isModalOpen: boolean;
  host: NetworkHostStatus | null;
  guest: NetworkGuestStatus;
  guestSong: SongView | null;
  guestTransport: NetworkGuestTransport | null;
  guestLiveSettings: NetworkLiveSettings | null;
  openModal: () => void;
  closeModal: () => void;
  setHost: (host: NetworkHostStatus) => void;
  setGuest: (guest: NetworkGuestStatus) => void;
  setGuestSong: (song: SongView | null) => void;
  setGuestTransport: (transport: NetworkGuestTransport) => void;
  setGuestLiveSettings: (settings: NetworkLiveSettings) => void;
  applyGuestSnapshot: (snapshot: NetworkGuestSnapshot) => void;
};

export const INITIAL_NETWORK_SESSION_STATE = {
  isModalOpen: false,
  host: null,
  guest: EMPTY_GUEST_STATUS,
  guestSong: null,
  guestTransport: null,
  guestLiveSettings: null,
};

export const useNetworkSessionStore = create<NetworkSessionState>()((set) => ({
  ...INITIAL_NETWORK_SESSION_STATE,
  openModal: () => set({ isModalOpen: true }),
  closeModal: () => set({ isModalOpen: false }),
  setHost: (host) => set({ host }),
  setGuest: (guest) =>
    set(
      guest.joined
        ? { guest }
        : // Left: forget what the host showed, so a later join never flashes
          // the previous host's song.
          { guest, guestSong: null, guestTransport: null, guestLiveSettings: null },
    ),
  setGuestSong: (guestSong) => set({ guestSong }),
  setGuestTransport: (guestTransport) => set({ guestTransport }),
  setGuestLiveSettings: (guestLiveSettings) => set({ guestLiveSettings }),
  applyGuestSnapshot: (snapshot) =>
    set({
      guest: snapshot.status,
      guestSong: snapshot.song,
      guestTransport: snapshot.transport,
      guestLiveSettings: snapshot.liveSettings,
    }),
}));

/** The guest screen takes over once joined, connected or not: losing the
 * Wi-Fi mid-song must not drop the musician back to their own session. */
export function isGuestScreenActive(guest: NetworkGuestStatus) {
  return guest.joined && guest.state !== "rejected" && guest.state !== "closed";
}
