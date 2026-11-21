/**
 * Recording one section's slide changes by tapping along (section editor).
 * The editor plays from a bar before the marker; the user taps (space bar,
 * or the big button on a phone) on each slide change. Each tap inside the
 * section is sent at once (the user sees it work) and kept; on Save, Rust
 * turns the taps into beats from the marker (`lyrics_section_steps_from_taps`),
 * so they follow the tempo.
 */

export type SectionSpan = {
  markerId: string;
  startSeconds: number;
  endSeconds: number;
};

export type RecorderDeps = {
  section: SectionSpan;
  /** The transport position now, in source seconds. */
  getPosition: () => Promise<number>;
  /** Send slide `k` of the section right away. */
  sendStep: (markerId: string, k: number) => void;
};

export function insideSection(section: SectionSpan, position: number): boolean {
  return position > section.startSeconds && position < section.endSeconds;
}

export function createStepRecorder({ section, getPosition, sendStep }: RecorderDeps) {
  const taps: number[] = [];
  return {
    /** One tap: kept and sent if it falls inside the section. Returns
     * whether it counted. */
    async tap() {
      const seconds = await getPosition();
      if (!insideSection(section, seconds)) return false;
      taps.push(seconds);
      sendStep(section.markerId, taps.length);
      return true;
    },
    taps: () => [...taps],
    count: () => taps.length,
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
