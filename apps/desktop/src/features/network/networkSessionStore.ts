import { create } from "zustand";
import { setGuestRole } from "@libretracks/shared/desktopApi";
import { recordProductEvent } from "../telemetry/telemetry";

import type {
  NetworkGuestSnapshot,
  NetworkGuestStatus,
  NetworkHostStatus,
} from "@libretracks/shared/networkApi";

/**
 * Network sessions, host and guest side (docs/plans/network-sessions).
 *
 * A store and not component state: the side-nav button, the topbar badge
 * and the modal never share a parent, and a session keeps running with the
 * modal closed. Nothing of this lives in `TransportPanelContent` (repo rule:
 * a new feature brings its own module).
 *
 * The host's song itself is not here: in mirror mode the whole app reads it
 * from the host through `desktopApi`.
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
  openModal: () => void;
  closeModal: () => void;
  setHost: (host: NetworkHostStatus) => void;
  setGuest: (guest: NetworkGuestStatus) => void;
  applyGuestSnapshot: (snapshot: NetworkGuestSnapshot) => void;
};

export const INITIAL_NETWORK_SESSION_STATE = {
  isModalOpen: false,
  host: null,
  guest: EMPTY_GUEST_STATUS,
};

export const useNetworkSessionStore = create<NetworkSessionState>()((set) => ({
  ...INITIAL_NETWORK_SESSION_STATE,
  openModal: () => set({ isModalOpen: true }),
  closeModal: () => set({ isModalOpen: false }),
  setHost: (host) => {
    if (host.hosting) recordProductEvent("feature_network_host");
    set({ host });
  },
  setGuest: (guest) => {
    if (guest.state === "connected") recordProductEvent("feature_network_guest");
    setGuestRole(guest.state === "connected" ? guest.role : null);
    set({ guest });
  },
  applyGuestSnapshot: (snapshot) => {
    if (snapshot.status.state === "connected") recordProductEvent("feature_network_guest");
    setGuestRole(snapshot.status.state === "connected" ? snapshot.status.role : null);
    set({ guest: snapshot.status });
  },
}));
