import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";

import { NetworkSessionModal } from "./NetworkSessionModal";
import { useNetworkSessionEvents } from "./useNetworkSessionEvents";

/**
 * Everything of network sessions that has to exist once per app: the event
 * subscription and the modal. Mounted by the transport panel with no props;
 * with the feature flag off it renders nothing and subscribes to nothing.
 */
export function NetworkSessionRoot() {
  if (!FEATURE_FLAGS.networkSessions) return null;
  return <NetworkSessionRootInner />;
}

function NetworkSessionRootInner() {
  useNetworkSessionEvents();
  return <NetworkSessionModal />;
}
