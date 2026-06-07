import type { MidiLearnCommand } from "./types";

export const HEADER_WIDTH = 260;
export const DEFAULT_TIMELINE_VIEWPORT_WIDTH = 1100;
export const TIMELINE_FIT_RIGHT_GUTTER_PX = 140;
export const TRACK_HEIGHT_MIN = 18;
export const TRACK_HEIGHT_MAX = 148;
export const TRACK_HEIGHT_STEP = 8;

export type TrackHeaderDensity =
  | "is-lane"
  | "is-micro"
  | "is-compact"
  | "is-condensed"
  | "";

export function densityFromHeight(trackHeight: number): TrackHeaderDensity {
  // Ableton-style single-line lane: everything but the name collapses away.
  if (trackHeight <= 44) return "is-lane";
  if (trackHeight <= 68) return "is-micro";
  if (trackHeight <= 80) return "is-compact";
  if (trackHeight <= 96) return "is-condensed";
  return "";
}
export const RULER_HEIGHT = 132;
export const ZOOM_MIN = 0.0625;
export const ZOOM_MAX = 64;
export const DRAG_THRESHOLD_PX = 6;
/** Snap radius (in viewport pixels) for the Ctrl-during-drag clip magnet. */
export const CLIP_SNAP_RADIUS_PX = 12;
export const LIVE_TRACK_MIX_MIN_INTERVAL_MS = 16;
export const SCROLL_COMMIT_DEBOUNCE_MS = 100;
export const LIVE_ZOOM_COMMIT_DEBOUNCE_MS = 150;
export const DOM_EXTERNAL_DROP_PREVIEW_TTL_MS = 250;
export const NATIVE_DND_DEBUG_ENABLED =
  import.meta.env.DEV && import.meta.env.VITE_NATIVE_DND_DEBUG === "true";

export const HARDWARE_OUTPUT_CHANNEL_COUNT = 8;
export const LIBRARY_DRAG_EDGE_BUFFER_PX = 50;
export const LIBRARY_DRAG_MAX_SCROLL_SPEED_PX = 22;
export const PLAYBACK_SNAPSHOT_REANCHOR_TOLERANCE_SECONDS = 0.08;

export const MIDI_LEARN_COMMANDS: MidiLearnCommand[] = [
  {
    key: "action:create_song",
    labelKey: "transport.settingsModal.midiLearnCreateSong",
  },
  {
    key: "action:open_project",
    labelKey: "transport.settingsModal.midiLearnOpenProject",
  },
  {
    key: "action:save_project",
    labelKey: "transport.settingsModal.midiLearnSaveProject",
  },
  {
    key: "action:save_project_as",
    labelKey: "transport.settingsModal.midiLearnSaveProjectAs",
  },
  { key: "action:undo", labelKey: "transport.settingsModal.midiLearnUndo" },
  { key: "action:redo", labelKey: "transport.settingsModal.midiLearnRedo" },
  { key: "action:play", labelKey: "timelineTopbar.play" },
  { key: "action:pause", labelKey: "timelineTopbar.pause" },
  { key: "action:stop", labelKey: "timelineTopbar.stop" },
  { key: "action:next_song", labelKey: "timelineTopbar.next" },
  {
    key: "action:select_previous_region",
    labelKey: "transport.settingsModal.midiLearnSelectPrevRegion",
  },
  {
    key: "action:select_next_region",
    labelKey: "transport.settingsModal.midiLearnSelectNextRegion",
  },
  {
    key: "action:region_transpose_up",
    labelKey: "transport.settingsModal.midiLearnTransposeUp",
  },
  {
    key: "action:region_transpose_down",
    labelKey: "transport.settingsModal.midiLearnTransposeDown",
  },
  {
    key: "action:region_transpose_reset",
    labelKey: "transport.settingsModal.midiLearnTransposeReset",
  },
  { key: "action:toggle_metronome", labelKey: "timelineTopbar.metronome" },
  { key: "action:toggle_vamp", labelKey: "timelineToolbar.vampButton" },
  { key: "action:cancel_jump", labelKey: "timelineToolbar.cancelJump" },
  {
    key: "action:create_marker",
    labelKey: "transport.settingsModal.midiLearnCreateMarker",
  },
  {
    key: "action:set_global_jump_mode_immediate",
    labelKey: "transport.settingsModal.midiLearnGlobalJumpModeImmediate",
  },
  {
    key: "action:set_global_jump_mode_after_bars",
    labelKey: "transport.settingsModal.midiLearnGlobalJumpModeAfterBars",
  },
  {
    key: "action:set_global_jump_mode_next_marker",
    labelKey: "transport.settingsModal.midiLearnGlobalJumpModeNextMarker",
  },
  {
    key: "action:increase_global_jump_bars",
    labelKey: "transport.settingsModal.midiLearnGlobalJumpBarsIncrease",
  },
  {
    key: "action:decrease_global_jump_bars",
    labelKey: "transport.settingsModal.midiLearnGlobalJumpBarsDecrease",
  },
  { key: "param:tempo", labelKey: "transport.settingsModal.midiLearnTempo" },
  {
    key: "param:global_jump_mode",
    labelKey: "transport.settingsModal.midiLearnGlobalJumpMode",
  },
  {
    key: "param:metronome_volume",
    labelKey: "transport.settingsModal.metronomeVolume",
  },
  {
    key: "param:global_jump_bars",
    labelKey: "transport.settingsModal.globalJumpBars",
  },
  {
    key: "action:set_song_jump_trigger_immediate",
    labelKey: "transport.settingsModal.midiLearnSongJumpTriggerImmediate",
  },
  {
    key: "action:set_song_jump_trigger_after_bars",
    labelKey: "transport.settingsModal.midiLearnSongJumpTriggerAfterBars",
  },
  {
    key: "action:set_song_jump_trigger_region_end",
    labelKey: "transport.settingsModal.midiLearnSongJumpTriggerRegionEnd",
  },
  {
    key: "action:increase_song_jump_bars",
    labelKey: "transport.settingsModal.midiLearnSongJumpBarsIncrease",
  },
  {
    key: "action:decrease_song_jump_bars",
    labelKey: "transport.settingsModal.midiLearnSongJumpBarsDecrease",
  },
  {
    key: "param:song_jump_trigger",
    labelKey: "transport.settingsModal.midiLearnSongJumpTrigger",
  },
  {
    key: "param:song_jump_bars",
    labelKey: "transport.settingsModal.songJumpBars",
  },
  {
    key: "action:set_song_transition_instant",
    labelKey: "transport.settingsModal.midiLearnSongTransitionInstant",
  },
  {
    key: "action:set_song_transition_fade_out",
    labelKey: "transport.settingsModal.midiLearnSongTransitionFadeOut",
  },
  {
    key: "param:song_transition_mode",
    labelKey: "transport.settingsModal.midiLearnSongTransitionMode",
  },
  {
    key: "action:set_vamp_mode_section",
    labelKey: "transport.settingsModal.midiLearnVampModeSection",
  },
  {
    key: "action:set_vamp_mode_bars",
    labelKey: "transport.settingsModal.midiLearnVampModeBars",
  },
  {
    key: "param:vamp_mode",
    labelKey: "transport.settingsModal.midiLearnVampMode",
  },
  {
    key: "action:increase_vamp_bars",
    labelKey: "transport.settingsModal.midiLearnVampBarsIncrease",
  },
  {
    key: "action:decrease_vamp_bars",
    labelKey: "transport.settingsModal.midiLearnVampBarsDecrease",
  },
  { key: "param:vamp_bars", labelKey: "transport.settingsModal.vampBars" },
  { key: "param:jump_bars", labelKey: "transport.settingsModal.jumpBars" },
];
