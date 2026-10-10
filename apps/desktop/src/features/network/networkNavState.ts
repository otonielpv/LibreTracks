import type { NetworkGuestStatus, NetworkHostStatus } from "@libretracks/shared/networkApi";

/** The dot on the side-nav «Red» button: null when there is no session. */
export function networkNavState(
  host: NetworkHostStatus | null,
  guest: NetworkGuestStatus,
): "ok" | "pending" | "error" | null {
  if (host?.hosting) return "ok";
  if (host?.suspended) return "pending";
  if (!guest.joined) return null;
  if (guest.state === "connected") return "ok";
  if (guest.state === "lost" || guest.state === "rejected") return "error";
  return "pending";
}
