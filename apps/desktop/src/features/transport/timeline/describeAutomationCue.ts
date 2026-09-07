import type { AutomationCueSummary, SongView } from "../desktopApi";
import { formatGainDb } from "@libretracks/shared/faderScale";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Human-readable, multi-line summary of a cue's job for the hover tooltip. */
export function describeAutomationCue(
  cue: AutomationCueSummary,
  song: SongView | null,
  t: Translate,
): string {
  const trackName = (id: string) =>
    song?.tracks.find((t) => t.id === id)?.name ?? id;
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
