import { useTranslation } from "react-i18next";

import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";

import { badgeView, formatOffset } from "./badgeView";
import { useRedundancyStore } from "./redundancyStore";

/**
 * Top-bar pill on both machines: can I switch to the backup? Readable from
 * a distance: colour + icon + text. Tapping it opens the detail panel.
 */
export function RedundancyBadge() {
  const { t, i18n } = useTranslation();
  const status = useRedundancyStore((state) => state.status);
  const openDetail = useRedundancyStore((state) => state.openDetail);
  if (!FEATURE_FLAGS.redundancy) return null;
  const view = badgeView(status);
  if (!view) return null;
  const offset = formatOffset(status?.offsetMs ?? null, i18n.language);
  const label = t(view.labelKey, { offset: offset || "–" });
  return (
    <div role="status" className="lt-redundancy-badge-slot">
      <button
        type="button"
        className={`lt-redundancy-badge is-${view.tone}`}
        aria-label={`${t("redundancy.title")}: ${label}`}
        onClick={openDetail}
      >
        <span className="material-symbols-outlined" aria-hidden="true" data-icon={view.icon}>
          {view.icon}
        </span>
        <span>{label}</span>
      </button>
    </div>
  );
}
