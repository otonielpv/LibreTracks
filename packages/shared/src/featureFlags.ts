/**
 * Features built but not shipped yet. A flag is a compile-time constant, not a
 * setting: with it off the feature has no UI at all (no button, no panel, no
 * remote widget), and users never see a switch.
 *
 * To ship a feature, set its flag to `true` in the release that brings it.
 */
export const FEATURE_FLAGS = {
  /** Lyrics & chords in the live view and the remote (PDF/ChordPro import,
   * sync with markers). Hidden in 1.14.0; planned for 1.15.0. */
  lyrics: true,
  /** Network sessions: LibreTracks apps joining a host LibreTracks over the
   * LAN with roles (viewer / control / edit). Plan in
   * docs/plans/network-sessions. In development; no release planned yet. */
  networkSessions: false,
} as const;
