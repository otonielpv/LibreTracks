import { memo } from "react";
import { useTranslation } from "react-i18next";

import { SnapIcon } from "../timeline/SnapIcon";
import { useTimelineUIStore } from "../uiStore";

type SetlistSnapToggleProps = {
  className?: string;
};

function SetlistSnapToggleComponent({ className = "" }: SetlistSnapToggleProps) {
  const { t } = useTranslation();
  const enabled = useTimelineUIStore((state) => state.snapEnabled);
  const toggle = useTimelineUIStore((state) => state.toggleSnapEnabled);
  const label = t(enabled ? "timelineToolbar.disableSnap" : "timelineToolbar.enableSnap");

  return (
    <button
      type="button"
      className={`lt-setlist-settings-button lt-setlist-snap-toggle${enabled ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      aria-pressed={enabled}
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      <SnapIcon enabled={enabled} size={20} />
    </button>
  );
}

export const SetlistSnapToggle = memo(SetlistSnapToggleComponent);
