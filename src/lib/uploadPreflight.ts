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
