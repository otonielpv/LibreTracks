import { useState } from "react";

import type { MidiClipDraft } from "../panels/MidiClipModal";
import type { MidiRouteDraft } from "../panels/MidiRouteModal";

/**
 * The MIDI feature's two open-dialog states (clip editor, track routing).
 *
 * Kept in a hook of its own rather than as more `useState` calls in the
 * transport panel: per the repo's rule a new feature brings its own module and
 * the monolith only wires it up.
 */
export function useMidiDrafts() {
  const [midiClipDraft, setMidiClipDraft] = useState<MidiClipDraft | null>(null);
  const [midiRouteDraft, setMidiRouteDraft] = useState<MidiRouteDraft | null>(
    null,
  );
  return {
    midiClipDraft,
    setMidiClipDraft,
    midiRouteDraft,
    setMidiRouteDraft,
  };
}
