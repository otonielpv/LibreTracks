/**
 * Recording slide changes by tapping along (plan lyrics-sync, step 09). The
 * user plays the song and taps (space bar, or the big button on a phone) on
 * each slide change. Each tap is sent at once (the user sees it work) and
 * kept; on Save, Rust turns the taps into beats from each section's start
 * (`lyrics_steps_from_taps`), so they follow the tempo.
 */

export type SectionSpan = {
  markerId: string;
  markerName: string;
  startSeconds: number;
  endSeconds: number;
  slides?: number;
};

export type RecorderDeps = {
  sections: SectionSpan[];
  /** The transport position now, in source seconds. */
  getPosition: () => Promise<number>;
  /** Send slide `k` of that section right away. */
  sendStep: (markerId: string, k: number) => void;
};

export type RecorderSummary = Array<{ markerName: string; changes: number }>;

export function sectionAt(sections: SectionSpan[], position: number): SectionSpan | null {
  return (
    sections.find((section) => position >= section.startSeconds && position < section.endSeconds) ??
    null
  );
}

export function createStepRecorder({ sections, getPosition, sendStep }: RecorderDeps) {
  const taps: Array<{ seconds: number; markerId: string }> = [];
  return {
    /** One tap: kept and sent if it falls inside a section. */
    async tap() {
      const seconds = await getPosition();
      const section = sectionAt(sections, seconds);
      if (!section) return null;
      taps.push({ seconds, markerId: section.markerId });
      const k = taps.filter((tap) => tap.markerId === section.markerId).length;
      sendStep(section.markerId, k);
      return section;
    },
    taps: () => taps.map((tap) => tap.seconds),
    /** "Verso 1: 1 change, Coro: 1 change", by section name in song order. */
    summary(): RecorderSummary {
      const counts = new Map<string, number>();
      for (const section of sections) {
        const changes = taps.filter((tap) => tap.markerId === section.markerId).length;
        if (changes > 0) {
          counts.set(section.markerName, (counts.get(section.markerName) ?? 0) + changes);
        }
      }
      return [...counts.entries()].map(([markerName, changes]) => ({ markerName, changes }));
    },
  };
}

export type StepRecorder = ReturnType<typeof createStepRecorder>;

function isSpace(event: KeyboardEvent) {
  return event.code === "Space" || event.key === " ";
}

/**
 * While recording, the space bar is a tap and nothing else: caught in the
 * capture phase on the window, before the transport's play/pause shortcut
 * ever sees it. Returns the function that gives the space bar back.
 */
export function captureSpaceBar(target: Window, onTap: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isSpace(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    if (!event.repeat) onTap();
  };
  const swallow = (event: KeyboardEvent) => {
    if (!isSpace(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  };
  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("keyup", swallow, true);
  return () => {
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("keyup", swallow, true);
  };
}
