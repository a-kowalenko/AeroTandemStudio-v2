/** Soft confirm when upload preflight finds files not listed in the manifest. */

export type BulkPreflightBucket = "ready" | "needs_decision" | "blocked";

export type BulkPreflightClassification = {
  bucket: BulkPreflightBucket;
  reasonCodes: string[];
};

export type UploadPreflightLike = {
  ok: boolean;
  hard_errors: Array<{ code: string; path?: string; detail?: string }>;
  soft_warnings: Array<{ code: string; path?: string; detail?: string }>;
};

export function primaryPreflightReasonCode(codes: string[]): string {
  return codes[0] ?? "unknown";
}

/** Sort bulk candidates into ready / needs user decision / blocked (Phase 31.6). */
export function classifyBulkPreflight(
  result: UploadPreflightLike,
): BulkPreflightClassification {
  const hardErrors = result.hard_errors;
  const softWarnings = result.soft_warnings;
  const extraFiles = softWarnings.filter((w) => w.code === "extra_file");
  const nonExtraSoft = softWarnings.filter((w) => w.code !== "extra_file");

  if (result.ok && hardErrors.length === 0) {
    if (extraFiles.length > 0) {
      return { bucket: "needs_decision", reasonCodes: ["extra_file"] };
    }
    if (nonExtraSoft.length > 0) {
      return {
        bucket: "blocked",
        reasonCodes: nonExtraSoft.map((w) => w.code),
      };
    }
    return { bucket: "ready", reasonCodes: [] };
  }

  if (hardErrors.length > 0) {
    if (canOfferPartialUpload(hardErrors) && extraFiles.length === 0) {
      return { bucket: "needs_decision", reasonCodes: ["file_missing"] };
    }
    const codes = hardErrors.map((e) => e.code);
    if (extraFiles.length > 0) {
      codes.push("extra_file");
    }
    return { bucket: "blocked", reasonCodes: codes };
  }

  if (extraFiles.length > 0) {
    return { bucket: "needs_decision", reasonCodes: ["extra_file"] };
  }

  const codes = nonExtraSoft.map((w) => w.code);
  return {
    bucket: "blocked",
    reasonCodes: codes.length > 0 ? codes : ["unknown"],
  };
}

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
