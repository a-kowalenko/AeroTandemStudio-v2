import { discardVideoCutUndoForPath } from "./tauri";
import { isCancellationError } from "./utils";
import { usePhotoStore } from "../store/photoStore";
import { useVideoStore } from "../store/videoStore";

/** Remove media imported during the current batch (working copies + UI state). */
export async function rollbackImportBatch(opts: {
  beforeVideoPaths: string[];
  beforePhotoPaths: string[];
}): Promise<void> {
  const videoList = useVideoStore.getState().videoList;
  const photoList = usePhotoStore.getState().photoList;
  const beforeVideos = new Set(opts.beforeVideoPaths.map((p) => p.toLowerCase()));
  const beforePhotos = new Set(opts.beforePhotoPaths.map((p) => p.toLowerCase()));

  const addedVideos = videoList
    .filter((v) => !beforeVideos.has(v.path.toLowerCase()))
    .map((v) => v.path);
  const addedPhotoIndices = photoList
    .map((p, i) => ({ path: p.path, index: i }))
    .filter(({ path }) => !beforePhotos.has(path.toLowerCase()))
    .map(({ index }) => index);

  for (const path of addedVideos) {
    useVideoStore.getState().clearCutMarksFor([path]);
    void discardVideoCutUndoForPath(path);
    useVideoStore.getState().removeVideo(path);
  }
  if (addedPhotoIndices.length > 0) {
    usePhotoStore.getState().removePhotos(addedPhotoIndices);
  }
}

export function isImportCancellation(error: unknown): boolean {
  return isCancellationError(error);
}
