import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordProductEvent } from "../telemetry/telemetry";
import {
  EMPTY_GUEST_STATUS,
  INITIAL_NETWORK_SESSION_STATE,
  useNetworkSessionStore,
} from "./networkSessionStore";

vi.mock("../telemetry/telemetry", () => ({ recordProductEvent: vi.fn() }));

describe("network session adoption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNetworkSessionStore.setState(INITIAL_NETWORK_SESSION_STATE);
  });

  it("does not count the modal or an unconnected guest as adoption", () => {
    const store = useNetworkSessionStore.getState();
    store.openModal();
    store.setGuest({ ...EMPTY_GUEST_STATUS, state: "connecting" });
    store.setGuest({ ...EMPTY_GUEST_STATUS, state: "rejected" });
    expect(recordProductEvent).not.toHaveBeenCalled();
  });

  it("records a host only while hosting", () => {
    const host = {
      hosting: false, hostName: "Host", port: 0, addresses: [],
      joinUrl: null, guests: [], trusted: [],
    };
    useNetworkSessionStore.getState().setHost(host);
    expect(recordProductEvent).not.toHaveBeenCalled();
    useNetworkSessionStore.getState().setHost({ ...host, hosting: true });
    expect(recordProductEvent).toHaveBeenCalledWith("feature_network_host");
  });

  it("records connected guests through status updates and mirror snapshots", () => {
    const store = useNetworkSessionStore.getState();
    const status = { ...EMPTY_GUEST_STATUS, state: "connected" as const };
    store.setGuest(status);
    expect(recordProductEvent).toHaveBeenCalledWith("feature_network_guest");
    vi.mocked(recordProductEvent).mockClear();
    store.applyGuestSnapshot({ status, song: null, transport: null, liveSettings: null });
    expect(recordProductEvent).toHaveBeenCalledWith("feature_network_guest");
  });
});
