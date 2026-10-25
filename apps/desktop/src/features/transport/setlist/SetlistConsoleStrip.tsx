import { memo, type CSSProperties, type ReactNode } from "react";
import { TRACK_FADER_SCALE, faderTicks } from "@libretracks/shared/faderScale";

import { CompactVerticalFader } from "../compact/CompactMixer";

// Same ticks as the track strips (computed once: the scale never changes).
const TRACK_FADER_TICKS = faderTicks(TRACK_FADER_SCALE);

type SetlistConsoleStripProps = {
  name: string;
  /** 0..1 fader position on the track fader scale. */
  position: number;
  ariaLabel: string;
  title?: string;
  formatValue: (position: number) => string;
  onChange: (position: number) => void;
  onCommit: () => void;
  onDoubleClick: () => void;
  /** The vertical meter, next to the fader like a track's. */
  meter?: ReactNode;
};

/**
 * A console strip that is not a track: the song Master. It is built with the
 * track strip's own markup and classes (CompactMixer): name band, the dB
 * scale, the same console fader and a vertical meter, so it looks and moves
 * like every other strip. Where a track has its pan and its output there are
 * invisible placeholders, so the fader has exactly the same travel.
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
  meter,
}: SetlistConsoleStripProps) {
  return (
    <div
      className="lt-compact-mixer-strip lt-setlist-master-strip"
      data-console-strip={name}
      title={title}
      style={{ "--track-accent": "var(--lt-setlist-accent)" } as CSSProperties}
    >
      <div className="lt-compact-mixer-strip-name" title={title ?? name}>
        <span className="lt-compact-mixer-strip-name-text">{name}</span>
      </div>
      <div className="lt-compact-mixer-strip-toggles lt-setlist-master-value" aria-hidden="true">
        {formatValue(position)}
      </div>
      <div className="lt-compact-mixer-fader-wrap">
        <div className="lt-compact-mixer-fader-scale" aria-hidden="true">
          {TRACK_FADER_TICKS.map((tick) => (
            <span key={tick.label} style={{ top: `${(tick.offsetFromTop * 100).toFixed(2)}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
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
      <div className="lt-compact-mixer-pan-wrap lt-setlist-strip-placeholder" aria-hidden="true">
        <div className="lt-compact-mixer-pan-guides">
          <span className="lt-compact-mixer-pan-guide is-left">L</span>
        </div>
        <div className="lt-compact-mixer-pan-track">
          <input type="range" className="lt-compact-mixer-pan lt-fader is-pan" tabIndex={-1} readOnly value={0} min={-1} max={1} />
        </div>
      </div>
      <select className="lt-compact-mixer-audio-to lt-setlist-strip-placeholder" aria-hidden="true" tabIndex={-1} disabled>
        <option value="" />
      </select>
    </div>
  );
}

export const SetlistConsoleStrip = memo(SetlistConsoleStripComponent);
