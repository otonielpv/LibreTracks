import { useTranslation } from "react-i18next";

import { TOUR_TARGETS } from "../../tutorial/tourTargets";
import { useCloudStore } from "./cloudStore";

/**
 * Opens the cloud panel from the landing screen.
 *
 * # Why the landing needs its own entry point
 *
 * The File menu gates on `canPersistProject`, so with no session open the whole
 * menu is disabled and will not even drop down — which puts the cloud out of
 * reach from the one screen where it matters most. Pulling a session down from
 * another device is exactly what you do *before* you have anything open.
 *
 * Lives here rather than inline in `TransportPanelContent` so the monolith
 * gains one line instead of a dozen: the file has a hard line budget and the
 * repo rule is to extract rather than raise it.
 */
export function CloudLandingButton() {
  const { t } = useTranslation();
  const openPanel = useCloudStore((state) => state.openPanel);

  return (
    <button type="button" data-lt-tour={TOUR_TARGETS.landingCloud} onClick={openPanel}>
      {t("transport.cloud.landingAction", { defaultValue: "Nube" })}
    </button>
  );
}
