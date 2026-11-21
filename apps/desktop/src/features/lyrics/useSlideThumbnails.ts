import { useEffect, useState } from "react";

/** Pictures asked at the same time. FreeShow renders each one in its own
 * hidden window with two fixed 3 s waits (~6 s, measured): in parallel, 8
 * cost the same as 1. More would mean that many windows open at once. */
const PARALLEL = 8;
/** Without a single picture after this many, the program gives none. */
const GIVE_UP_AFTER = 3;

type Load = (presentationId: string, indexes: number[], cachedOnly?: boolean) => Promise<Array<string | null>>;

/** Pictures already read, by `presentationId:index` (`null` = none). Kept
 * for the session; Rust also keeps them on disk per presentation version. */
const cache = new Map<string, string | null>();

const key = (presentationId: string, index: number) => `${presentationId}:${index}`;

/** Forget the pictures (tests, or a presentation edited in the program). */
export function clearSlideThumbnails() {
  cache.clear();
}

/**
 * The picture of each slide of a presentation, read in the background:
 * first the ones already on disk (at once), then the rest a few at a time in
 * parallel. Missing ones stay out of the map: the editor shows the slide's
 * text instead.
 */
export function useSlideThumbnails(
  presentationId: string | null | undefined,
  indexes: number[],
  load: Load,
): Map<number, string> {
  const wanted = indexes.join(",");
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!presentationId) return () => {};
    let alive = true;
    const bump = () => {
      if (alive) setVersion((version) => version + 1);
    };
    const keep = (batch: number[], pictures: Array<string | null>) =>
      batch.forEach((index, i) => cache.set(key(presentationId, index), pictures[i] ?? null));

    void (async () => {
      let missing = indexes.filter((index) => !cache.has(key(presentationId, index)));
      if (missing.length === 0) return;
      // What is on disk comes back in one call, without rendering anything.
      try {
        const stored = await load(presentationId, missing, true);
        const found = missing.filter((_, i) => Boolean(stored[i]));
        keep(
          found,
          found.map((index) => stored[missing.indexOf(index)]),
        );
        missing = missing.filter((_, i) => !stored[i]);
        if (found.length > 0) bump();
      } catch {
        return;
      }

      let next = 0;
      let got = false;
      let empty = 0;
      let stop = false;
      const worker = async () => {
        while (alive && !stop && next < missing.length) {
          const index = missing[next++];
          let picture: string | null = null;
          try {
            picture = (await load(presentationId, [index]))[0] ?? null;
          } catch {
            stop = true;
            return;
          }
          keep([index], [picture]);
          got ||= Boolean(picture);
          if (!picture) empty += 1;
          // A program without pictures (Holyrics) answers nothing from the
          // start: stop asking after a few.
          if (!got && empty >= GIVE_UP_AFTER) {
            stop = true;
            missing.forEach((other) => {
              if (!cache.has(key(presentationId, other))) cache.set(key(presentationId, other), null);
            });
          }
          bump();
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, missing.length) }, worker));
    })();
    return () => {
      alive = false;
    };
    // `wanted` stands for `indexes`; `load` is stable (handlers factory).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentationId, wanted]);

  const pictures = new Map<number, string>();
  if (presentationId) {
    for (const index of indexes) {
      const picture = cache.get(key(presentationId, index));
      if (picture) pictures.set(index, picture);
    }
  }
  return pictures;
}
