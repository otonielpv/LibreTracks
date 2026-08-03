import type { SongView } from "../desktopApi";
import {
  MidiClipModal,
  type MidiClipDraft,
  type MidiClipModalResult,
} from "../panels/MidiClipModal";
import { MidiRouteModal, type MidiRouteDraft } from "../panels/MidiRouteModal";

/**
 * The MIDI feature's two dialogs (clip editor and track routing), mounted
 * together so the transport panel carries one element instead of two blocks of
 * draft plumbing. Purely presentational: all state lives in the caller.
 */
export type MidiModalsProps = {
  song: SongView | null;
  /** The two dialog states plus their closer, straight from useMidiDrafts. */
  drafts: {
    midiClipDraft: MidiClipDraft | null;
    midiRouteDraft: MidiRouteDraft | null;
    closeDraft: (kind: "clip" | "route") => void;
  };
  availablePorts: string[];
  onRefreshPorts: () => void;
  /** Fire the editor's current values without saving them. */
  onTestClip: (result: MidiClipModalResult) => void;
  onSaveClip: (result: MidiClipModalResult) => void;
  onSaveRoute: (
    trackId: string,
    port: string | null,
    channel: number,
  ) => void;
};

export function MidiModals({
  song,
  drafts,
  availablePorts,
  onRefreshPorts,
  onTestClip,
  onSaveClip,
  onSaveRoute,
}: MidiModalsProps) {
  const { midiClipDraft: clipDraft, midiRouteDraft: routeDraft, closeDraft } =
    drafts;
  return (
    <>
      {routeDraft ? (
        <MidiRouteModal
          key={routeDraft.trackId}
          draft={routeDraft}
          availablePorts={availablePorts}
          onRefreshPorts={onRefreshPorts}
          onCancel={() => closeDraft("route")}
          onConfirm={(result) => {
            const trackId = routeDraft.trackId;
            closeDraft("route");
            onSaveRoute(trackId, result.port, result.channel);
          }}
        />
      ) : null}

      {clipDraft ? (
        <MidiClipModal
          key={clipDraft.clipId ?? "new"}
          draft={clipDraft}
          song={song}
          onCancel={() => closeDraft("clip")}
          onTest={onTestClip}
          onConfirm={(result) => {
            closeDraft("clip");
            onSaveClip(result);
          }}
        />
      ) : null}
    </>
  );
}
