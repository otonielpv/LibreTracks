import type { DragEvent as ReactDragEvent } from "react";

export const LIBRARY_ASSET_DRAG_MIME = "application/libretracks-library-assets";

const SUPPORTED_AUDIO_EXTENSIONS = new Set(["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a"]);

export type ExternalDropKind = "package" | "audio" | "mixed" | "unsupported" | "unknown";

export type ExternalDropPreview = {
  kind: ExternalDropKind;
  seconds: number;
};

export type DroppedFileClassification = {
  kind: ExternalDropKind;
  files: File[];
  packageFile: File | null;
  audioFiles: File[];
  unsupportedFiles: File[];
};

export type NativeDroppedPathClassification =
  | {
      kind: "package";
      packagePath: string;
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
  const audioFiles: File[] = [];
  const unsupportedFiles: File[] = [];

  for (const file of files) {
    const extension = fileExtension(file.name);
    if (extension === "ltpkg") {
      packageFiles.push(file);
      continue;
    }

    if (SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
      audioFiles.push(file);
      continue;
    }

    unsupportedFiles.push(file);
  }

  if (packageFiles.length === 1 && audioFiles.length === 0 && unsupportedFiles.length === 0 && files.length === 1) {
    return {
      kind: "package",
      files,
      packageFile: packageFiles[0],
      audioFiles: [],
      unsupportedFiles: [],
    };
  }

  if (packageFiles.length > 0) {
    return {
      kind: "mixed",
      files,
      packageFile: packageFiles[0] ?? null,
      audioFiles,
      unsupportedFiles,
    };
  }

  if (audioFiles.length > 0 && unsupportedFiles.length === 0) {
    return {
      kind: "audio",
      files,
      packageFile: null,
      audioFiles,
      unsupportedFiles: [],
    };
  }

  return {
    kind: "unsupported",
    files,
    packageFile: null,
    audioFiles,
    unsupportedFiles,
  };
}

export function classifyDroppedPaths(paths: string[]): NativeDroppedPathClassification {
  const packagePaths: string[] = [];
  const audioPaths: string[] = [];
  const unsupportedPaths: string[] = [];

  for (const path of paths) {
    const extension = fileExtension(pathFileName(path));
    if (extension === "ltpkg") {
      packagePaths.push(path);
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
    audioPaths.length === 0 &&
    unsupportedPaths.length === 0 &&
    paths.length === 1
  ) {
    return {
      kind: "package",
      packagePath: packagePaths[0],
    };
  }

  if (packagePaths.length > 0) {
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