/** Shared media type helpers for drag/drop and file pickers. */

export const VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "avi",
  "m4v",
  "webm",
  "mts",
  "m2ts",
] as const;

export const PHOTO_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "bmp",
  "tiff",
  "tif",
  "webp",
  "heic",
  "dng",
] as const;

export type MediaKind = "video" | "photo";

function extensionOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function mediaKind(path: string): MediaKind | null {
  const ext = extensionOf(path);
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return "video";
  if ((PHOTO_EXTENSIONS as readonly string[]).includes(ext)) return "photo";
  return null;
}

export function splitMediaPaths(paths: string[]): {
  videos: string[];
  photos: string[];
  skipped: string[];
} {
  const videos: string[] = [];
  const photos: string[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    const kind = mediaKind(path);
    if (kind === "video") videos.push(path);
    else if (kind === "photo") photos.push(path);
    else skipped.push(path);
  }
  return { videos, photos, skipped };
}
