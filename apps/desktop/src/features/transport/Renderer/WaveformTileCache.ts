import type { ClipSummary, WaveformLodDto, WaveformSummaryDto } from "../desktopApi";
import { clamp } from "../timelineMath";

export const WAVEFORM_TILE_WIDTH_PX = 1024;
const TILE_HEIGHT_PX = 256;
const decodedWaveformLodCache = new WeakMap<WaveformLodDto, ResolvedWaveformLod>();

type ResolvedWaveformLod = {
  resolutionFrames: number;
  bucketCount: number;
  minPeaks: Float32Array;
  maxPeaks: Float32Array;
};

type TileSurface = OffscreenCanvas | HTMLCanvasElement;

type TileEntry = {
  namespace: string;
  canvas: TileSurface;
  width: number;
  height: number;
};

export type WaveformTile = {
  canvas: TileSurface;
  tileStartPixel: number;
  tileWidth: number;
};

type TileRequest = {
  clip: ClipSummary;
  waveform: WaveformSummaryDto;
  pixelsPerSecond: number;
  clipPixelWidth: number;
  tileIndex: number;
};

function decodeBase64ToBytes(base64: string) {
  if (typeof atob === "function") {
    const decoded = atob(base64);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }

    return bytes;
  }

  return new Uint8Array(0);
}

export function decodeFloat32Peaks(base64: string | undefined, expectedCount: number) {
  if (!base64 || expectedCount <= 0) {
    return new Float32Array(0);
  }

  const bytes = decodeBase64ToBytes(base64);
  const availableCount = Math.min(expectedCount, Math.floor(bytes.byteLength / 4));
  const values = new Float32Array(availableCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let index = 0; index < availableCount; index += 1) {
    values[index] = view.getFloat32(index * 4, true);
  }

  return values;
}

function resolveWaveformLod(lod: WaveformLodDto): ResolvedWaveformLod {
  const cached = decodedWaveformLodCache.get(lod);
  if (cached) {
    return cached;
  }

  const resolved = {
    resolutionFrames: lod.resolutionFrames,
    bucketCount: lod.bucketCount,
    minPeaks: lod.minPeaks
      ? Float32Array.from(lod.minPeaks)
      : decodeFloat32Peaks(lod.minPeaksBase64, lod.bucketCount),
    maxPeaks: lod.maxPeaks
      ? Float32Array.from(lod.maxPeaks)
      : decodeFloat32Peaks(lod.maxPeaksBase64, lod.bucketCount),
  };
  decodedWaveformLodCache.set(lod, resolved);
  return resolved;
}

export function selectWaveformLod(
  waveform: WaveformSummaryDto | undefined,
  pixelsPerSecond: number,
): ResolvedWaveformLod | null {
  if (!waveform?.lods.length) {
    return null;
  }

  const framesPerPixel =
    waveform.sampleRate > 0 && pixelsPerSecond > 0
      ? waveform.sampleRate / pixelsPerSecond
      : waveform.lods[0].resolutionFrames;
  let selectedLod = waveform.lods[0];

  for (const lod of waveform.lods) {
    if (lod.resolutionFrames <= framesPerPixel) {
      selectedLod = lod;
      continue;
    }

    break;
  }

  return resolveWaveformLod(selectedLod);
}

function createTileSurface(width: number, height: number): TileSurface | null {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  return null;
}

function getTileContext(surface: TileSurface) {
  return surface.getContext("2d");
}

function tileNamespace(request: TileRequest) {
  return [
    request.clip.waveformKey,
    request.waveform.version,
    request.waveform.sampleRate,
    request.waveform.durationSeconds.toFixed(6),
    request.clip.sourceStartSeconds.toFixed(6),
    request.clip.sourceDurationSeconds.toFixed(6),
    request.clip.durationSeconds.toFixed(6),
    request.pixelsPerSecond.toFixed(4),
    request.waveform.isPreview ? "preview" : "ready",
  ].join(":");
}

function tileKey(namespace: string, tileIndex: number) {
  return `${namespace}:tile:${tileIndex}`;
}

function renderWaveformTile(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  request: TileRequest,
  tileStartPixel: number,
  tileWidth: number,
) {
  const waveformLod = selectWaveformLod(request.waveform, request.pixelsPerSecond);
  const maxPeaks = waveformLod?.maxPeaks ?? new Float32Array(0);
  const minPeaks = waveformLod?.minPeaks ?? new Float32Array(0);
  if (
    !maxPeaks.length ||
    !minPeaks.length ||
    tileWidth < 2 ||
    request.clipPixelWidth < 2 ||
    request.clip.sourceDurationSeconds <= 0
  ) {
    return;
  }

  const clipStartRatio = clamp(request.clip.sourceStartSeconds / request.clip.sourceDurationSeconds, 0, 1);
  const clipSpanRatio = clamp(request.clip.durationSeconds / request.clip.sourceDurationSeconds, 0, 1);
  const clipStartIndex = Math.max(0, Math.floor(clipStartRatio * maxPeaks.length));
  const clipEndIndex = Math.min(
    maxPeaks.length,
    Math.max(clipStartIndex + 1, Math.ceil((clipStartRatio + clipSpanRatio) * maxPeaks.length)),
  );
  const clipSampleCount = clipEndIndex - clipStartIndex;
  if (clipSampleCount <= 0) {
    return;
  }

  const tileEndPixel = Math.min(request.clipPixelWidth, tileStartPixel + tileWidth);
  const startIndex = Math.max(
    clipStartIndex,
    clipStartIndex + Math.floor((tileStartPixel / request.clipPixelWidth) * clipSampleCount),
  );
  const endIndex = Math.min(
    clipEndIndex,
    Math.max(startIndex + 1, clipStartIndex + Math.ceil((tileEndPixel / request.clipPixelWidth) * clipSampleCount)),
  );
  if (startIndex >= endIndex || startIndex >= minPeaks.length) {
    return;
  }

  context.clearRect(0, 0, tileWidth, TILE_HEIGHT_PX);
  context.fillStyle = request.waveform.isPreview ? "rgba(20, 20, 20, 0.34)" : "rgba(20, 20, 20, 0.72)";
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();

  const xDenominator = Math.max(1, clipSampleCount - 1);
  const pxPerBucket = request.clipPixelWidth / xDenominator;
  const shouldUseSteppedPeaks = pxPerBucket > 5;
  let previousTopY = 0;

  for (let index = startIndex; index < endIndex; index += 1) {
    const clipLocalX = ((index - clipStartIndex) / xDenominator) * request.clipPixelWidth;
    const x = clipLocalX - tileStartPixel;
    const y = TILE_HEIGHT_PX * 0.5 - clamp(maxPeaks[index], -1, 1) * TILE_HEIGHT_PX * 0.42;
    if (index === startIndex) {
      context.moveTo(x, y);
      previousTopY = y;
    } else {
      if (shouldUseSteppedPeaks) {
        context.lineTo(x, previousTopY);
      }
      context.lineTo(x, y);
      previousTopY = y;
    }
  }

  let previousBottomY = 0;
  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    const clipLocalX = ((index - clipStartIndex) / xDenominator) * request.clipPixelWidth;
    const x = clipLocalX - tileStartPixel;
    const y = TILE_HEIGHT_PX * 0.5 - clamp(minPeaks[index], -1, 1) * TILE_HEIGHT_PX * 0.42;
    if (index === endIndex - 1) {
      previousBottomY = y;
    } else if (shouldUseSteppedPeaks) {
      context.lineTo(x, previousBottomY);
    }
    context.lineTo(x, y);
    previousBottomY = y;
  }

  context.closePath();
  context.fill();
}

export class WaveformTileCache {
  private readonly tiles = new Map<string, TileEntry>();

  getTile(request: TileRequest): WaveformTile | null {
    const namespace = tileNamespace(request);
    const tileStartPixel = request.tileIndex * WAVEFORM_TILE_WIDTH_PX;
    const tileWidth = Math.max(
      1,
      Math.ceil(Math.min(WAVEFORM_TILE_WIDTH_PX, request.clipPixelWidth - tileStartPixel)),
    );
    if (tileWidth <= 0) {
      return null;
    }

    const key = tileKey(namespace, request.tileIndex);
    let entry = this.tiles.get(key);
    if (!entry) {
      const surface = createTileSurface(tileWidth, TILE_HEIGHT_PX);
      if (!surface) {
        return null;
      }

      const context = getTileContext(surface);
      if (!context) {
        return null;
      }

      renderWaveformTile(context, request, tileStartPixel, tileWidth);
      entry = {
        namespace,
        canvas: surface,
        width: tileWidth,
        height: TILE_HEIGHT_PX,
      };
      this.tiles.set(key, entry);
    }

    return {
      canvas: entry.canvas,
      tileStartPixel,
      tileWidth: entry.width,
    };
  }

  pruneNamespaces(activeNamespaces: Set<string>) {
    for (const [key, entry] of this.tiles) {
      if (!activeNamespaces.has(entry.namespace)) {
        this.tiles.delete(key);
      }
    }
  }

  buildNamespace(clip: ClipSummary, waveform: WaveformSummaryDto, pixelsPerSecond: number) {
    return tileNamespace({
      clip,
      waveform,
      pixelsPerSecond,
      clipPixelWidth: Math.max(1, clip.durationSeconds * pixelsPerSecond),
      tileIndex: 0,
    });
  }
}