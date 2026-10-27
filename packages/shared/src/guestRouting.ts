import { GUEST_COMMAND_ROUTES } from "./guestCommandTable";
import type { NetworkRole } from "./networkRoles";

export function guestCanInvoke(role: NetworkRole | null, command: string): boolean {
  if (command.startsWith("link_")) return true;
  switch (GUEST_COMMAND_ROUTES[command]) {
    case "local":
    case "view":
      return true;
    case "control":
    case "custom":
      return role === "controller" || role === "editor";
    case "edit":
      return role === "editor";
    default:
      return false;
  }
}

/**
 * Where a desktop command runs when this device is a network-session guest
 * in mirror mode: here (about this device), on the host (the session), or
 * nowhere (needs the host's files, dialogs or devices). Pure, so it is
 * tested without Tauri. The table is generated from scripts/link-commands.json.
 */
export function guestRouteFor(command: string): "local" | "host" | "blocked" {
  // The network-session commands themselves always run here.
  if (command.startsWith("link_")) return "local";
  const route = GUEST_COMMAND_ROUTES[command];
  if (route === "local") return "local";
  // Unclassified counts as blocked: a new command is never sent to a host
  // until someone decides who may run it there.
  if (route === undefined || route === "blocked") return "blocked";
  return "host";
}
