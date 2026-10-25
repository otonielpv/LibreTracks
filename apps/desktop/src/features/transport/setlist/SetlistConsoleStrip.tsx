import { memo, type ReactNode } from "react";

import { CompactVerticalFader } from "../compact/CompactMixer";

type SetlistConsoleStripProps = {
  name: string;
  /** 0..1 fader position (the caller owns the dB scale). */
  position: number;
  ariaLabel: string;
  title?: string;
  formatValue: (position: number) => string;
  onChange: (position: number) => void;
  onCommit: () => void;
  onDoubleClick: () => void;
  /** On/off and a settings button, above the fader. */
  toggles?: ReactNode;
  meter?: ReactNode;
  variant?: "aux" | "master";
};

/**
 * A console strip that is not a track: Click, Guide and the song Master.
 * Same console fader as the track strips (CompactVerticalFader), so the
 * whole console reads as one mixer.
 */
function SetlistConsoleStripComponent({
  name,
  position,
  ariaLabel,
  title,
  formatValue,
  onChange,
  onCommit,
  onDoubleClick,
  toggles,
  meter,
  variant = "aux",
}: SetlistConsoleStripProps) {
  return (
    <div
      className={`lt-setlist-console-strip is-${variant}`}
      title={title}
      data-console-strip={name}
    >
      <span className="lt-setlist-console-strip-name">{name}</span>
      {toggles ? <div className="lt-setlist-console-strip-toggles">{toggles}</div> : null}
      <div className="lt-setlist-console-strip-fader">
        <CompactVerticalFader
          value={position}
          onChange={onChange}
          onCommit={onCommit}
          onDoubleClick={onDoubleClick}
          ariaLabel={ariaLabel}
          formatValue={formatValue}
        />
        {meter}
      </div>
      <span className="lt-setlist-console-strip-value">{formatValue(position)}</span>
    </div>
  );
}

export const SetlistConsoleStrip = memo(SetlistConsoleStripComponent);
