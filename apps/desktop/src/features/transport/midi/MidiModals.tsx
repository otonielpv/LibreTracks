import type { MidiEventSummary, SongView } from "../desktopApi";
import { MidiClipModal, type MidiClipDraft } from "../panels/MidiClipModal";
import { MidiRouteModal, type MidiRouteDraft } from "../panels/MidiRouteModal";

/**
 * The MIDI feature's two dialogs (clip editor and track routing), mounted
 * together so the transport panel carries one element instead of two blocks of
 * draft plumbing. Purely presentational: all state lives in the caller.
 */
export type MidiModalsProps = {
  song: SongView | null;
  clipDraft: MidiClipDraft | null;
  routeDraft: MidiRouteDraft | null;
  availablePorts: string[];
  onCloseClip: () => void;
  onCloseRoute: () => void;
  onSaveClip: (result: {
    clipId: string | null;
    trackId: string;
    timelineStartSeconds: number;
    name: string;
    events: MidiEventSummary[];
  }) => void;
  onSaveRoute: (
    trackId: string,
    port: string | null,
    channel: number,
  ) => void;
};

export function MidiModals({
  song,
  clipDraft,
  routeDraft,
  availablePorts,
  onCloseClip,
  onCloseRoute,
  onSaveClip,
  onSaveRoute,
}: MidiModalsProps) {
  return (
    <>
      {routeDraft ? (
        <MidiRouteModal
          draft={routeDraft}
          availablePorts={availablePorts}
          onCancel={onCloseRoute}
          onConfirm={(result) => {
            const trackId = routeDraft.trackId;
            onCloseRoute();
            onSaveRoute(trackId, result.port, result.channel);
          }}
        />
      ) : null}

      {clipDraft ? (
        <MidiClipModal
          draft={clipDraft}
          song={song}
          onCancel={onCloseClip}
          onConfirm={(result) => {
            onCloseClip();
            onSaveClip(result);
          }}
        />
      ) : null}
    </>
  );
}
