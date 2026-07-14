import type { DragEvent as ReactDragEvent } from "react";

import {
  clamp,
  clientXToLocalX,
  localXToClientX,
  screenXToSeconds,
  secondsToScreenX,
} from "../timeline/timelineMath";

export const LIBRARY_ASSET_DRAG_MIME = "application/libretracks-library-assets";

const SUPPORTED_AUDIO_EXTENSIONS = new Set(["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a"]);

// Reaper / Ableton project files: dropping one imports it as a song, like a
// .ltpkg. Single-file only (mixing with audio/other files is rejected).
const EXTERNAL_PROJECT_EXTENSIONS = new Set(["rpp", "als"]);

/** True for file names the compact + DAW drop pipelines actually
 * accept (any supported audio extension, a LibreTracks package, or a
 * Reaper/Ableton project). Used to reject unsupported drops at the entry
 * point so the user doesn't see misleading "imported" feedback for files
 * we'd silently drop on the floor. */
export function isAcceptedDroppedFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return (
    ext === "ltpkg" ||
    SUPPORTED_AUDIO_EXTENSIONS.has(ext) ||
    EXTERNAL_PROJECT_EXTENSIONS.has(ext)
  );
}

export type ExternalDropKind =
  | "package"
  | "external"
  | "audio"
  | "mixed"
  | "unsupported"
  | "unknown";

export type ExternalDropPreview = {
  kind: ExternalDropKind;
  seconds: number;
  previewLeftPx?: number;
  previewClientX?: number;
  rawSeconds?: number;
  snappedSeconds?: number;
  snapApplied?: boolean;
};

export function resolveExternalDropGuideLeft(
  preview: ExternalDropPreview,
  trackLayersBounds:
    | (Pick<DOMRect, "left"> &
        Partial<Pick<DOMRect, "width">> & { layoutWidth?: number })
    | null,
  fallbackLeft: number,
) {
  if (preview.snapApplied) {
    return Math.round(fallbackLeft);
  }

  if (preview.previewClientX != null && trackLayersBounds) {
    return "width" in trackLayersBounds && trackLayersBounds.layoutWidth
      ? clientXToLocalX(
          preview.previewClientX,
          {
            left: trackLayersBounds.left,
            width: trackLayersBounds.width ?? trackLayersBounds.layoutWidth,
          },
          trackLayersBounds.layoutWidth,
        )
      : preview.previewClientX - trackLayersBounds.left;
  }

  return preview.previewLeftPx ?? fallbackLeft;
}

export function buildTimelineDropPreviewGeometry(args: {
  clientX: number;
  viewportLeft: number;
  viewportWidth: number;
  viewportLayoutWidth?: number;
  cameraX: number;
  pixelsPerSecond: number;
  snappedSeconds: number;
  snapEnabled: boolean;
}) {
  const viewportBounds = {
    left: args.viewportLeft,
    width: args.viewportWidth,
  };
  const viewportLayoutWidth = args.viewportLayoutWidth ?? args.viewportWidth;
  const viewportX = clamp(
    clientXToLocalX(args.clientX, viewportBounds, args.viewportLayoutWidth),
    0,
    viewportLayoutWidth,
  );
  const rawSeconds = screenXToSeconds(viewportX, args.cameraX, args.pixelsPerSecond);
  const dropSeconds = args.snapEnabled ? args.snappedSeconds : rawSeconds;
  const rawLeftPx = clamp(
    secondsToScreenX(rawSeconds, args.cameraX, args.pixelsPerSecond),
    0,
    viewportLayoutWidth,
  );
  const snappedLeftPx = clamp(
    secondsToScreenX(args.snappedSeconds, args.cameraX, args.pixelsPerSecond),
    0,
    viewportLayoutWidth,
  );
  const previewLeftPx = args.snapEnabled ? Math.round(snappedLeftPx) : rawLeftPx;

  return {
    viewportX,
    rawSeconds,
    snappedSeconds: args.snappedSeconds,
    dropSeconds,
    rawLeftPx,
    rawClientX: localXToClientX(
      rawLeftPx,
      viewportBounds,
      args.viewportLayoutWidth,
    ),
    snappedLeftPx,
    snappedClientX: localXToClientX(
      snappedLeftPx,
      viewportBounds,
      args.viewportLayoutWidth,
    ),
    previewLeftPx,
    previewClientX: localXToClientX(
      previewLeftPx,
      viewportBounds,
      args.viewportLayoutWidth,
    ),
    snapApplied: args.snapEnabled,
  };
}

export type DroppedFileClassification = {
  kind: ExternalDropKind;
  files: File[];
  packageFile: File | null;
  externalFile: File | null;
  audioFiles: File[];
  unsupportedFiles: File[];
};

export type NativeDroppedPathClassification =
  | {
      kind: "package";
      packagePath: string;
    }
  | {
      kind: "external";
      externalPath: string;
    }
  | {
      kind: "audio";
      audioPaths: string[];
    }
  | {
      kind: "mixed";
      paths: string[];
    }
  | {
      kind: "unsupported";
      paths: string[];
    };

function getTransferTypes(dataTransfer: DataTransfer | null) {
  return Array.from(dataTransfer?.types ?? []);
}

function hasTransferType(dataTransfer: DataTransfer | null, value: string) {
  return getTransferTypes(dataTransfer).includes(value);
}

function fileExtension(fileName: string) {
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex < 0 || lastDotIndex === fileName.length - 1) {
    return "";
  }

  return fileName.slice(lastDotIndex + 1).toLowerCase();
}

function pathFileName(path: string) {
  return path.split(/[\\/]/).at(-1) ?? path;
}

export function isInternalLibraryDrag(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return false;
  }

  return hasTransferType(dataTransfer, LIBRARY_ASSET_DRAG_MIME) || hasTransferType(dataTransfer, "text/plain");
}

export function isExternalFileDrag(dataTransfer: DataTransfer | null) {
  if (!dataTransfer || isInternalLibraryDrag(dataTransfer)) {
    return false;
  }

  return hasTransferType(dataTransfer, "Files");
}

export function getDroppedFiles(dataTransfer: DataTransfer | null) {
  const files = Array.from(dataTransfer?.files ?? []);
  if (files.length > 0) {
    return files;
  }

  return Array.from(dataTransfer?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function classifyDroppedFiles(files: File[]): DroppedFileClassification {
  const packageFiles: File[] = [];
  const externalFiles: File[] = [];
  const audioFiles: File[] = [];
  const unsupportedFiles: File[] = [];

  for (const file of files) {
    const extension = fileExtension(file.name);
    if (extension === "ltpkg") {
      packageFiles.push(file);
      continue;
    }

    if (EXTERNAL_PROJECT_EXTENSIONS.has(extension)) {
      externalFiles.push(file);
      continue;
    }

    if (SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
      audioFiles.push(file);
      continue;
    }

    unsupportedFiles.push(file);
  }

  if (
    packageFiles.length === 1 &&
    externalFiles.length === 0 &&
    audioFiles.length === 0 &&
    unsupportedFiles.length === 0 &&
    files.length === 1
  ) {
    return {
      kind: "package",
      files,
      packageFile: packageFiles[0],
      externalFile: null,
      audioFiles: [],
      unsupportedFiles: [],
    };
  }

  if (
    externalFiles.length === 1 &&
    packageFiles.length === 0 &&
    audioFiles.length === 0 &&
    unsupportedFiles.length === 0 &&
    files.length === 1
  ) {
    return {
      kind: "external",
      files,
      packageFile: null,
      externalFile: externalFiles[0],
      audioFiles: [],
      unsupportedFiles: [],
    };
  }

  if (packageFiles.length > 0 || externalFiles.length > 0) {
    return {
      kind: "mixed",
      files,
      packageFile: packageFiles[0] ?? null,
      externalFile: externalFiles[0] ?? null,
      audioFiles,
      unsupportedFiles,
    };
  }

  if (audioFiles.length > 0 && unsupportedFiles.length === 0) {
    return {
      kind: "audio",
      files,
      packageFile: null,
      externalFile: null,
      audioFiles,
      unsupportedFiles: [],
    };
  }

  return {
    kind: "unsupported",
    files,
    packageFile: null,
    externalFile: null,
    audioFiles,
    unsupportedFiles,
  };
}

export function classifyDroppedPaths(paths: string[]): NativeDroppedPathClassification {
  const packagePaths: string[] = [];
  const externalPaths: string[] = [];
  const audioPaths: string[] = [];
  const unsupportedPaths: string[] = [];

  for (const path of paths) {
    const extension = fileExtension(pathFileName(path));
    if (extension === "ltpkg") {
      packagePaths.push(path);
      continue;
    }

    if (EXTERNAL_PROJECT_EXTENSIONS.has(extension)) {
      externalPaths.push(path);
      continue;
    }

    if (SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
      audioPaths.push(path);
      continue;
    }

    unsupportedPaths.push(path);
  }

  if (
    packagePaths.length === 1 &&
    externalPaths.length === 0 &&
    audioPaths.length === 0 &&
    unsupportedPaths.length === 0 &&
    paths.length === 1
  ) {
    return {
      kind: "package",
      packagePath: packagePaths[0],
    };
  }

  if (
    externalPaths.length === 1 &&
    packagePaths.length === 0 &&
    audioPaths.length === 0 &&
    unsupportedPaths.length === 0 &&
    paths.length === 1
  ) {
    return {
      kind: "external",
      externalPath: externalPaths[0],
    };
  }

  if (packagePaths.length > 0 || externalPaths.length > 0) {
    return {
      kind: "mixed",
      paths,
    };
  }

  if (audioPaths.length > 0 && unsupportedPaths.length === 0) {
    return {
      kind: "audio",
      audioPaths,
    };
  }

  return {
    kind: "unsupported",
    paths,
  };
}

export function classifyDroppedFilesFromEvent(event: ReactDragEvent<HTMLElement>) {
  return classifyDroppedFiles(getDroppedFiles(event.dataTransfer));
}
