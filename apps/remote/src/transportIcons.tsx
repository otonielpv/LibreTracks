/**
 * Transport icons as inline SVG (the remote ships no icon font). 24×24,
 * `currentColor`, so a button's state colours them.
 */
import type { ReactNode } from "react";

type IconProps = { className?: string };

const svg = (path: ReactNode, className?: string) => (
  <svg
    className={className ?? "transport-icon"}
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    {path}
  </svg>
);

export const PlayIcon = ({ className }: IconProps) => svg(<path d="M7 4.5v15l12.5-7.5z" />, className);

export const PauseIcon = ({ className }: IconProps) =>
  svg(
    <>
      <rect x="6" y="4.5" width="4.2" height="15" rx="1" />
      <rect x="13.8" y="4.5" width="4.2" height="15" rx="1" />
    </>,
    className,
  );

export const StopIcon = ({ className }: IconProps) =>
  svg(<rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />, className);

/** A volume ramp down into a stop: «Fade out y parar». */
export const FadeStopIcon = ({ className }: IconProps) =>
  svg(
    <>
      <path d="M2.5 6.5 14 17.5H2.5z" opacity="0.55" />
      <rect x="16" y="9" width="6" height="8.5" rx="1" />
    </>,
    className,
  );

export const MetronomeIcon = ({ className }: IconProps) =>
  svg(
    <path d="M10 2.5h4l4.6 18.5H5.4zm.9 2L8.8 13h6.4L13.1 4.5zM8.3 15l-.8 4h9l-.8-4zm4.4-1.6 5.6-7.6 1.4 1-5.4 7.3z" />,
    className,
  );

/** A speaking head: the voice guide. */
export const VoiceIcon = ({ className }: IconProps) =>
  svg(
    <path d="M9.5 4a5.5 5.5 0 0 0-5.5 5.5c0 1.6.7 3 1.7 4V20h7v-2.5h2.3c.8 0 1.5-.7 1.5-1.5v-2.5l1.5-.5-1.6-3.3A5.5 5.5 0 0 0 9.5 4zm9.3 1.6-1.1 1.1a7 7 0 0 1 0 9.9l1.1 1.1a8.6 8.6 0 0 0 0-12.1zm-2.3 2.3-1.1 1.1a3.8 3.8 0 0 1 0 5.4l1.1 1.1a5.4 5.4 0 0 0 0-7.6z" />,
    className,
  );

/** A crossed-out screen: emergency black on the projector. */
export const BlackScreenIcon = ({ className }: IconProps) =>
  svg(
    <path d="M3.3 2.2 2.2 3.3 4 5.1A2 2 0 0 0 3 6.8v9.4c0 1.1.9 2 2 2h4v2h6v-1.9l5.7 5.7 1.1-1.1zM5 16.2V6.8l9.4 9.4zM19 4.8H7.8l2 2H19v9.4h-.8l2 2a2 2 0 0 0 .8-1.6V6.8c0-1.1-.9-2-2-2z" />,
    className,
  );
