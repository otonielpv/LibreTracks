export * from "@libretracks/shared/models";
export * from "@libretracks/shared/desktopApi";

import * as shared from "@libretracks/shared/desktopApi";

// Every way of adding audio (importing, "Add to timeline", dropping on a song,
// folder drops...) ends in one of these calls, so this is where a successful
// add counts as a good moment to ask for a store rating. The local exports
// below shadow the `export *` ones above. Dynamic import: storeReview reads
// the transport store, which imports this module.
function noteAudioAdded() {
  void import("../storeReview/storeReview")
    .then(({ noteStoreReviewMoment }) => noteStoreReviewMoment("audioAdded"))
    .catch(() => undefined);
}

function countingAudioAdded<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    const result = await call(...args);
    if (result !== null) noteAudioAdded();
    return result;
  };
}

export const importLibraryAssetsFromDialog = countingAudioAdded(shared.importLibraryAssetsFromDialog);
export const importAudioFilesFromBytes = countingAudioAdded(shared.importAudioFilesFromBytes);
export const importAudioFilesFromPaths = countingAudioAdded(shared.importAudioFilesFromPaths);
export const createClip = countingAudioAdded(shared.createClip);
export const createClipsBatch = countingAudioAdded(shared.createClipsBatch);
export const createClipsWithAutoTracks = countingAudioAdded(shared.createClipsWithAutoTracks);
