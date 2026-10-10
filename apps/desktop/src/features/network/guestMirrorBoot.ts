import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import { isTauriApp, setGuestMirrorMode } from "@libretracks/shared/desktopApi";
import { getGuestSnapshot, type NetworkGuestStatus } from "@libretracks/shared/networkApi";

/** Joined and not given up: the UI runs against the host's session. */
export function wantsMirrorMode(status: NetworkGuestStatus) {
  return status.joined && status.state !== "rejected" && status.state !== "closed";
}

/**
 * Before the app mounts: is this device following a host? Then every
 * session command and event goes to/comes from the host (mirror mode). The
 * backend keeps the connection across a reload, which is how entering and
 * leaving the mode works: join or leave, then reload.
 *
 * Never blocks boot for long: without an answer in 1.5 s the app starts
 * normally (a backend without network sessions, a browser preview).
 */
export async function bootGuestMirrorMode(): Promise<boolean> {
  if (!FEATURE_FLAGS.networkSessions || !isTauriApp) return false;
  try {
    const snapshot = await Promise.race([
      getGuestSnapshot(),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1500)),
    ]);
    const on = Boolean(snapshot && wantsMirrorMode(snapshot.status));
    setGuestMirrorMode(on);
    document.documentElement.classList.toggle("lt-guest-mirror", on);
    return on;
  } catch {
    return false;
  }
}
