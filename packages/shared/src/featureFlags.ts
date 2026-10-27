/**
 * Features built but not shipped yet. A flag is a compile-time constant, not a
 * setting: with it off the feature has no UI at all (no button, no panel, no
 * remote widget), and users never see a switch.
 *
 * To ship a feature, set its flag to `true` in the release that brings it.
 */
export const FEATURE_FLAGS = {
  /** Lyrics & chords in the live view and the remote (PDF/ChordPro import,
   * sync with markers). Hidden in 1.14.0; ships in 1.15.0. */
  lyrics: true,
  /** Network sessions: LibreTracks apps joining a host LibreTracks over the
   * LAN with roles (viewer / control / edit). Plan in
   * docs/plans/network-sessions. Planned for 1.16.0. */
  networkSessions: true,
  /** «Analizar canción…»: tempo, key and section markers read from a song's
   * click, guide and audio. Ships in 1.15.0. */
  songAnalysis: true,
  /** Song templates: new songs from a template, stems organised on drop by
   * match aliases, and the «one folder per song» track layout. Planned for
   * 1.16.0. Its USER_MANUAL sections were taken out while hidden: bring them
   * back from commit 29da2994 when it ships. */
  songTemplates: true,
} as const;
