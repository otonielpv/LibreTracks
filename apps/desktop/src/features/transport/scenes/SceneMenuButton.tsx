import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isMobileApp } from "../desktopApi";
import { PopoverShell } from "../panels/PopoverShell";
import { useTransportStore } from "../store";
import { SceneButtons } from "./SceneButtons";

/** The phone screens the Live view already lays out for (LivePerformanceView.css). */
const PHONE_QUERY = "(max-width: 820px), (max-height: 500px)";

/**
 * A phone in the app: there a row of scene buttons takes a quarter of the
 * mixer's height and squeezes the strips, so the scenes fold into one button.
 * Tablets and desktop keep the row.
 */
export function usePhoneScreen(): boolean {
  const [phone, setPhone] = useState(
    () => isMobileApp && typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches === true,
  );
  useEffect(() => {
    if (!isMobileApp || !window.matchMedia) return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

/**
 * One «Scenes» button that opens the scene buttons in a popover; lit while a
 * scene is engaged. Nothing renders without scenes, like the row.
 */
export function SceneMenuButton({ className, disabled = false }: { className?: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const count = useTransportStore((state) => state.playback?.mixScenes?.length ?? 0);
  const engaged = useTransportStore((state) => (state.playback?.activeMixSceneIds?.length ?? 0) > 0);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  if (count === 0) return null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`lt-scene-menu-button${engaged ? " is-active" : ""}${className ? ` ${className}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t(engaged ? "transport.mixScene.menuButtonActive" : "transport.mixScene.buttonsLabel")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          layers
        </span>
        {t("transport.mixScene.menuButton")}
      </button>
      <PopoverShell
        open={open}
        anchorRef={anchorRef}
        ariaLabel={t("transport.mixScene.buttonsLabel")}
        onClose={() => setOpen(false)}
        className="lt-pads-popover lt-scene-menu"
      >
        <SceneButtons className="lt-scene-menu-list" disabled={disabled} />
      </PopoverShell>
    </>
  );
}

/** The scenes where a view hosts them: the row, or on a phone the button. */
export function SceneBar({
  className,
  menuClassName,
  disabled = false,
}: {
  className?: string;
  menuClassName?: string;
  disabled?: boolean;
}) {
  const phone = usePhoneScreen();
  return phone ? (
    <SceneMenuButton className={menuClassName} disabled={disabled} />
  ) : (
    <SceneButtons className={className} disabled={disabled} />
  );
}
