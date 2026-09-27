import { useTranslation } from "react-i18next";

import { isMobileApp } from "../desktopApi";
import { WIZARD_STEP_DISPLAY, VideoSetupWizard } from "./VideoSetupWizard";
import { useVideoStore } from "./videoStore";

/**
 * Everything the display setup (paso 10) puts on screen: the non-blocking
 * notice on opening a session with video, and the wizard. The transport panel
 * only mounts this; desktop only.
 */
export function VideoSetupLayer() {
  if (isMobileApp) return null;
  return (
    <>
      <VideoSetupNotice />
      <VideoSetupWizard />
    </>
  );
}

export function VideoSetupNotice() {
  const { t } = useTranslation();
  const notice = useVideoStore((state) => state.setupNotice);
  const wizardOpen = useVideoStore((state) => state.wizardOpen);
  if (!notice || wizardOpen) return null;

  const store = useVideoStore.getState();
  const missing = notice.kind === "displayMissing";
  return (
    <div className="lt-video-setup-notice" role="status" aria-live="polite">
      <span className="material-symbols-outlined" aria-hidden="true">
        {missing ? "tv_off" : "tv"}
      </span>
      <span>
        {missing
          ? t("transport.video.notice.displayMissing", { name: notice.displayName })
          : t("transport.video.notice.configure")}
      </span>
      <button type="button" onClick={() => store.openWizard(missing ? WIZARD_STEP_DISPLAY : 0)}>
        {missing ? t("transport.video.notice.chooseOther") : t("transport.video.notice.setUp")}
      </button>
      <button type="button" onClick={() => store.dismissSetupNotice()}>
        {missing ? t("transport.video.notice.continueWithout") : t("transport.video.notice.notNow")}
      </button>
    </div>
  );
}
