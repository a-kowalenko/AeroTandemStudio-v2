/** Soft confirm when upload preflight finds files not listed in the manifest. */

export type UploadExtraFilesConfirmState = {
  vorgangId: number;
  guest: string;
  extraPaths: string[];
};

export type UploadPreflightHardFailState = {
  guest: string;
  issues: Array<{ code: string; path: string; detail: string }>;
};

export type UploadMissingFilesState = {
  guest: string;
  folderPath: string;
  missingPaths: string[];
};

export type UploadPartialConfirmState = {
  guest: string;
  missingPaths: string[];
};

export const UPLOAD_PREFLIGHT_FILE_MISSING = "file_missing";

export function canOfferPartialUpload(
  hardErrors: Array<{ code: string }>,
): boolean {
  if (hardErrors.length === 0) return false;
  return hardErrors.every((e) => e.code === UPLOAD_PREFLIGHT_FILE_MISSING);
}

export function missingFilePathsFromPreflight(
  hardErrors: Array<{ code: string; path: string }>,
): string[] {
  return hardErrors
    .filter((e) => e.code === UPLOAD_PREFLIGHT_FILE_MISSING && e.path)
    .map((e) => e.path);
}
