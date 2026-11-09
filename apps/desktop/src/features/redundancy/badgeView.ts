import type { RedundancyStatus } from "./redundancyApi";

export type BadgeTone = "idle" | "pending" | "ok" | "error" | "lost" | "standalone";

/** What the top-bar pill shows: tone (colour), icon and the i18n key of
 * its text. Colour is never the only signal: text and icon change too. */
export type BadgeView = {
  tone: BadgeTone;
  icon: string;
  labelKey: string;
  /** The live offset goes into the text (none today: it flickered). */
  withOffset: boolean;
};

export function badgeView(status: RedundancyStatus | null): BadgeView | null {
  if (!status || status.role === "off") return null;
  if (status.role === "main") {
    switch (status.state) {
      case "backupConnected":
        if (status.backupPhase === "checkingSession") {
          return { tone: "pending", icon: "fact_check", labelKey: "redundancy.badge.mainChecking", withOffset: false };
        }
        return { tone: "pending", icon: "sync", labelKey: "redundancy.badge.mainSyncing", withOffset: false };
      case "backupArmed":
        return { tone: "ok", icon: "verified", labelKey: "redundancy.badge.mainArmed", withOffset: false };
      case "backupMismatch":
        return { tone: "error", icon: "difference", labelKey: "redundancy.badge.mainMismatch", withOffset: false };
      case "backupLost":
        return { tone: "lost", icon: "link_off", labelKey: "redundancy.badge.mainLostBackup", withOffset: false };
      default:
        // No backup (yet): nothing to say on the main, no pill in the way.
        return null;
    }
  }
  switch (status.state) {
    case "following":
      return { tone: "pending", icon: "sync", labelKey: "redundancy.badge.following", withOffset: false };
    case "armed":
      return { tone: "ok", icon: "verified", labelKey: "redundancy.badge.armed", withOffset: false };
    case "sessionMismatch":
      return { tone: "error", icon: "difference", labelKey: "redundancy.badge.sessionMismatch", withOffset: false };
    case "mainLost":
      return { tone: "lost", icon: "warning", labelKey: "redundancy.badge.mainLost", withOffset: false };
    case "standalone":
      return { tone: "standalone", icon: "person", labelKey: "redundancy.badge.standalone", withOffset: false };
    case "diverged":
      return { tone: "error", icon: "call_split", labelKey: "redundancy.badge.diverged", withOffset: false };
    case "checkingSession":
      return { tone: "pending", icon: "fact_check", labelKey: "redundancy.badge.checking", withOffset: false };
    default:
      if (status.connectionError) {
        return { tone: "error", icon: "link_off", labelKey: "redundancy.badge.cannotConnect", withOffset: false };
      }
      return { tone: "idle", icon: "shield", labelKey: "redundancy.badge.connecting", withOffset: false };
  }
}

export function formatOffset(offsetMs: number | null, language: string): string {
  if (offsetMs === null || !Number.isFinite(offsetMs)) return "";
  return new Intl.NumberFormat(language, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Math.abs(offsetMs));
}
