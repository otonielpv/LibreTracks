import { useTranslation } from "react-i18next";

import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";

import { useNetworkSessionStore } from "./networkSessionStore";

/**
 * Topbar pill while a network session is active: «Anfitrión · 4»,
 * «Invitado · Lector · 12 ms», or «Conexión perdida» in red. Self-contained
 * like the device badges: no props into the transport tree. Tapping it opens
 * the network-session modal.
 */
export function NetworkSessionBadge() {
  const { t } = useTranslation();
  const host = useNetworkSessionStore((state) => state.host);
  const guest = useNetworkSessionStore((state) => state.guest);
  const openModal = useNetworkSessionStore((state) => state.openModal);

  if (!FEATURE_FLAGS.networkSessions) return null;

  let label: string | null = null;
  let tone = "is-ok";
  if (host?.hosting) {
    label = t("networkSession.badge.hosting", { count: host.guests.length });
  } else if (host?.suspended) {
    label = t("networkSession.badge.suspended");
    tone = "is-pending";
  } else if (guest.joined) {
    if (guest.state === "connected") {
      label = t("networkSession.badge.guest", {
        role: guest.role ? t(`networkSession.roles.${guest.role}`) : "",
      });
      if (guest.rttMs !== null) {
        label += ` · ${t("networkSession.latency", { ms: Math.round(guest.rttMs / 2) })}`;
      }
    } else if (guest.state === "lost") {
      label = t("networkSession.badge.lost");
      tone = "is-error";
    } else if (guest.state === "rejected") {
      label = t("networkSession.badge.rejected");
      tone = "is-error";
    } else {
      label = t("networkSession.badge.connecting");
      tone = "is-pending";
    }
  }
  if (!label) return null;

  return (
    <button
      type="button"
      className={`lt-network-badge ${tone}`}
      onClick={openModal}
      aria-label={t("networkSession.title")}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        hub
      </span>
      {label}
    </button>
  );
}
