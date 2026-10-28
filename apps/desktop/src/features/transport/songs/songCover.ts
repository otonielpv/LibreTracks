import { findSongCoverImages, isTauriApp, setSongRegionCover } from "../desktopApi";

export const MAX_COVER_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_COVER_DATA_LENGTH = 128 * 1024;

export function pickCoverFile(onSelected: (file: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp";
  input.hidden = true;
  input.onchange = () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onSelected(file);
  };
  input.oncancel = () => input.remove();
  document.body.appendChild(input);
  input.click();
}

export async function normalizeCoverImage(source: File | string): Promise<string> {
  if (typeof source !== "string" && source.size > MAX_COVER_FILE_BYTES) {
    throw new Error("Cover image exceeds 8 MB");
  }
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Invalid cover image"));
      element.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Invalid cover dimensions");
    const scale = Math.min(1, 384 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.65, 0.45]) {
      const data = canvas.toDataURL("image/jpeg", quality);
      if (data.startsWith("data:image/jpeg;base64,") && data.length <= MAX_COVER_DATA_LENGTH) return data;
    }
    throw new Error("Cover image is too large");
  } finally {
    if (typeof source !== "string") URL.revokeObjectURL(url);
  }
}

export async function assignFolderCover(regionId: string, paths: string[], folderName: string) {
  if (!isTauriApp || paths.length === 0) return null;
  try {
    const candidates = await findSongCoverImages(paths, folderName);
    for (const candidate of candidates) {
      let image: string;
      try { image = await normalizeCoverImage(candidate); }
      catch { continue; }
      return await setSongRegionCover(regionId, image);
    }
  } catch (error) {
    console.warn("Could not assign folder cover", error);
  }
  return null;
}