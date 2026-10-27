import { isGuestMirrorMode } from "@libretracks/shared/desktopApi";
import { useNetworkSessionStore } from "./networkSessionStore";

export function useNetworkPermissions() {
  const guest = useNetworkSessionStore((state) => state.guest);
  const isGuest = isGuestMirrorMode();
  const connected = guest.state === "connected";
  return {
    isGuest,
    canControl: !isGuest || (connected && (guest.role === "controller" || guest.role === "editor")),
    canEdit: !isGuest || (connected && guest.role === "editor"),
    canUseFiles: !isGuest,
  };
}
