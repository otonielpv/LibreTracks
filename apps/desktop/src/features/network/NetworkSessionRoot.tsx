import { useEffect, useRef } from "react";

import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import { isGuestMirrorMode } from "@libretracks/shared/desktopApi";

import { wantsMirrorMode } from "./guestMirrorBoot";
import { NetworkSessionModal } from "./NetworkSessionModal";
import { useNetworkSessionStore } from "./networkSessionStore";
import { reloadApp } from "./reloadApp";
import { useNetworkSessionEvents } from "./useNetworkSessionEvents";

/**
 * Everything of network sessions that has to exist once per app: the event
 * subscription, the modal, and the switch into and out of mirror mode.
 * Mounted by the transport panel with no props; with the feature flag off it
 * renders nothing and subscribes to nothing.
 */
export function NetworkSessionRoot() {
  if (!FEATURE_FLAGS.networkSessions) return null;
  return <NetworkSessionRootInner />;
}

/**
 * Mirror mode is decided at boot (guestMirrorBoot.ts), so the app reloads to
 * enter or leave it:
 * - joined and connected while still on this device's session → enter;
 * - in mirror mode and the session is over (left, kicked, refused) → leave,
 *   back to this device's own session, untouched;
 * - in mirror mode, back from a lost connection → reload to refetch the
 *   host's session instead of patching up whatever was missed.
 */
export function mirrorTransition(
  inMirror: boolean,
  previousState: string,
  guest: { joined: boolean; state: string },
): "enter" | "leave" | "refresh" | null {
  if (!inMirror) {
    return guest.joined && guest.state === "connected" ? "enter" : null;
  }
  if (!wantsMirrorMode(guest as Parameters<typeof wantsMirrorMode>[0])) return "leave";
  if (previousState === "lost" && guest.state === "connected") return "refresh";
  return null;
}

function NetworkSessionRootInner() {
  useNetworkSessionEvents();
  const guest = useNetworkSessionStore((state) => state.guest);
  const previousState = useRef(guest.state);

  useEffect(() => {
    // The first status after boot is the backend's snapshot; before it
    // arrives the store holds the empty default, which must not read as
    // "left".
    if (guest.state === "" && !guest.joined) return;
    const transition = mirrorTransition(isGuestMirrorMode(), previousState.current, guest);
    previousState.current = guest.state;
    if (transition) reloadApp();
  }, [guest]);

  return <NetworkSessionModal />;
}
