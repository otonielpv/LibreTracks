import type { AutomationCueSummary, SongView } from "../desktopApi";
import { formatGainDb } from "@libretracks/shared/faderScale";
import { METRONOME_SOUND_PRESETS } from "@libretracks/shared/models";
import { trackDisplayName } from "../panels/trackSongGroups";
import { VOICE_GUIDE_LANGUAGE_OPTIONS } from "../panels/ClickGuideActionEditors";
import { voiceGuideCountStyleLabel } from "../songs/songCountStyle";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Human-readable, multi-line summary of a cue's job for the hover tooltip. */
export function describeAutomationCue(
  cue: AutomationCueSummary,
  song: SongView | null,
  t: Translate,
): string {
  // Con el nombre de la canción cuando se repite: «Silenciar Drums» no dice
  // cuál de los cinco «Drums» de la sesión.
  const trackName = (id: string) => trackDisplayName(song, id);
  const sceneName = (id: string) =>
    song?.mixScenes?.find((s) => s.id === id)?.name ?? id;
  const targetName = (target: AutomationCueSummary["actions"][number]) => {
    if (target.type !== "jump") return "";
    const jumpTarget = target.target;
    if (jumpTarget.kind === "region") {
      return (
        song?.regions.find((r) => r.id === jumpTarget.regionId)?.name ??
        t("transport.automation.defaultRegionTarget")
      );
    }
    if (jumpTarget.kind === "marker") {
      return (
        song?.sectionMarkers.find((m) => m.id === jumpTarget.markerId)?.name ??
        t("transport.automation.defaultMarkerTarget")
      );
    }
    return `${jumpTarget.seconds.toFixed(2)}s`;
  };

  const onOff = (on: boolean) =>
    t(on ? "transport.automation.cueOn" : "transport.automation.cueOff");
  const field = (labelKey: string, value: string) =>
    `${t(`transport.settingsModal.${labelKey}`)}: ${value}`;
  const joinChanges = (changes: Array<string | null>) =>
    changes.filter((change): change is string => change !== null).join(" · ");

  const lines = (cue.actions ?? []).map((action) => {
    switch (action.type) {
      case "jump": {
        const fade =
          action.transition.mode === "fade_out" &&
          (action.transition.durationSeconds ?? 0) > 0
            ? t("transport.automation.cueFadeSuffix", {
                seconds: (action.transition.durationSeconds ?? 0).toFixed(1),
              })
            : "";
        return t("transport.automation.cueJumpLine", {
          target: targetName(action),
          fade,
        });
      }
      case "setTrackMute":
        return `${t(
          action.muted
            ? "transport.automation.cueMute"
            : "transport.automation.cueUnmute",
        )} ${trackName(action.trackId)}`;
      case "setTrackSolo":
        return `${t(
          action.solo
            ? "transport.automation.cueSolo"
            : "transport.automation.cueUnsolo",
        )} ${trackName(action.trackId)}`;
      case "setTrackMix": {
        const parts: string[] = [];
        if (action.volume != null)
          parts.push(`vol ${Math.round(action.volume * 100)}`);
        if (action.pan != null)
          parts.push(`pan ${Math.round(action.pan * 100)}`);
        return `${trackName(action.trackId)}: ${parts.join(", ") || t("transport.automation.cueMixFallback")}`;
      }
      case "applyScene":
        return t("transport.automation.cueScene", {
          name: sceneName(action.sceneId),
        });
      case "setPad":
        return t(action.enabled
          ? "transport.automation.cuePadOn"
          : "transport.automation.cuePadOff", {
          pack: action.padId,
          key: ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][action.padKey] ?? "C",
          volume: formatGainDb(action.volume),
          output: action.output,
        });
      case "setMetronome": {
        const preset = (index: number) =>
          t(`transport.settingsModal.metronomePreset.${METRONOME_SOUND_PRESETS[index] ?? ""}`, {
            defaultValue: METRONOME_SOUND_PRESETS[index] ?? String(index),
          });
        const changes = [
          action.enabled != null ? onOff(action.enabled) : null,
          action.accentEnabled != null
            ? field("metronomeAccentEnabled", onOff(action.accentEnabled))
            : null,
          action.accentPreset != null
            ? field("metronomeAccentSound", preset(action.accentPreset))
            : null,
          action.beatPreset != null
            ? field("metronomeBeatSound", preset(action.beatPreset))
            : null,
          action.subdivision != null
            ? field(
                "metronomeSubdivision",
                t(`transport.settingsModal.metronomeSubdivisionOption.${action.subdivision}`, {
                  defaultValue: action.subdivision === 1 ? "Off" : `1/${action.subdivision}`,
                }),
              )
            : null,
          action.subdivisionPreset != null
            ? field("metronomeSubdivisionSound", preset(action.subdivisionPreset))
            : null,
          action.output != null ? field("metronomeOutput", action.output) : null,
        ];
        return t("transport.automation.cueMetronome", { changes: joinChanges(changes) });
      }
      case "setVoiceGuide": {
        const changes = [
          action.enabled != null ? onOff(action.enabled) : null,
          action.language != null
            ? field(
                "voiceGuideLanguage",
                VOICE_GUIDE_LANGUAGE_OPTIONS.find((o) => o.value === action.language)?.label ??
                  action.language,
              )
            : null,
          action.countInEnabled != null
            ? `${t("transport.automation.voiceGuideCountIn")}: ${onOff(action.countInEnabled)}`
            : null,
          action.countStyle != null
            ? field("voiceGuideCountStyle", voiceGuideCountStyleLabel(t, action.countStyle))
            : null,
          action.leadBars != null ? field("voiceGuideLeadBars", String(action.leadBars)) : null,
          action.output != null ? field("voiceGuideOutput", action.output) : null,
        ];
        return t("transport.automation.cueVoiceGuide", { changes: joinChanges(changes) });
      }
      case "wait":
        return t("transport.automation.cueWait", {
          seconds: action.durationSeconds,
        });
    }
  });

  const runs =
    cue.maxRuns != null
      ? t("transport.automation.cueRuns", { count: cue.maxRuns })
      : "";
  const header = `${cue.name} - ${cue.atSeconds.toFixed(2)}s${runs}${cue.enabled ? "" : t("transport.automation.cueDisabled")}`;
  return lines.length ? `${header}\n${lines.join("\n")}` : header;
}
