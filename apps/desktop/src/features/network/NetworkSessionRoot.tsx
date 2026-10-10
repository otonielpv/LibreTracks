import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";

import { GuestLiveScreen } from "./GuestLiveScreen";
import { NetworkSessionModal } from "./NetworkSessionModal";
import { isGuestScreenActive, useNetworkSessionStore } from "./networkSessionStore";
import { useNetworkSessionEvents } from "./useNetworkSessionEvents";

/**
 * Everything of network sessions that has to exist once per app: the event
 * subscription, the modal and, while joined to a host, the guest screen over
 * the whole app. Mounted by the transport panel with no props;
 * with the feature flag off it renders nothing and subscribes to nothing.
 */
export function NetworkSessionRoot() {
  if (!FEATURE_FLAGS.networkSessions) return null;
  return <NetworkSessionRootInner />;
}

function NetworkSessionRootInner() {
  useNetworkSessionEvents();
  const guestScreen = useNetworkSessionStore((state) => isGuestScreenActive(state.guest));
  return (
    <>
      {guestScreen ? <GuestLiveScreen /> : null}
      <NetworkSessionModal />
    </>
  );
}
